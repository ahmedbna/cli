// src/utils/installManager.ts
//
// Manages background dependency installation while the AI agent runs in parallel.
//
// Key design:
//   - `npm install` starts immediately after template copy (non-blocking)
//   - Agent runs concurrently, writing files (which doesn't need deps)
//   - When agent calls `runCommand` (e.g. `npx expo install <pkg>`), it awaits
//     the base install first, then runs the new-package install serialized
//     behind a mutex so we don't get npm lockfile conflicts.
//   - Status is polled/awaited rather than event-based so we stay simple.
//
// States: 'pending' | 'installing' | 'ready' | 'failed'

import { spawn, type ChildProcess } from 'child_process';
import { log } from './logger.js';
import chalk from 'chalk';

export type InstallStatus = 'pending' | 'installing' | 'ready' | 'failed';

interface InstallResult {
  ok: boolean;
  error?: string;
  durationMs: number;
}

export class InstallManager {
  private status: InstallStatus = 'pending';
  private basePromise: Promise<InstallResult> | null = null;
  private mutex: Promise<unknown> = Promise.resolve();
  private baseError: string | null = null;
  private baseProc: ChildProcess | null = null;
  private startedAt = 0;
  private finishedAt = 0;
  /** Set when .abort() is called so close-handlers don't retry after a kill. */
  private aborted = false;

  constructor(private projectRoot: string) {}

  /**
   * Start the base `npm install` in the background.
   * Returns immediately — does NOT await completion.
   * Stdout/stderr are captured (not piped to terminal) so they don't collide
   * with the streaming agent output.
   */
  startBaseInstall(): void {
    if (this.basePromise) return; // idempotent

    this.status = 'installing';
    this.startedAt = Date.now();

    this.basePromise = new Promise<InstallResult>((resolve) => {
      const proc = spawn('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
      });

      this.baseProc = proc;

      let stderrBuf = '';
      proc.stderr?.on('data', (chunk) => {
        // Only keep the tail — npm stderr can be huge
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 8192) {
          stderrBuf = stderrBuf.slice(-4096);
        }
      });

      proc.on('error', (err) => {
        this.finishedAt = Date.now();
        this.status = 'failed';
        this.baseError = err.message;
        resolve({
          ok: false,
          error: err.message,
          durationMs: this.finishedAt - this.startedAt,
        });
      });

      proc.on('close', (code) => {
        this.finishedAt = Date.now();
        if (code === 0) {
          this.status = 'ready';
          resolve({
            ok: true,
            durationMs: this.finishedAt - this.startedAt,
          });
        } else if (this.aborted) {
          // User aborted — don't retry
          this.status = 'failed';
          this.baseError = 'aborted by user';
          resolve({
            ok: false,
            error: 'aborted',
            durationMs: this.finishedAt - this.startedAt,
          });
        } else {
          // Retry once with --legacy-peer-deps on failure
          this.retryWithLegacyPeerDeps(stderrBuf).then(resolve);
        }
      });
    });
  }

  private async retryWithLegacyPeerDeps(
    originalStderr: string,
  ): Promise<InstallResult> {
    log.warn(
      'npm install failed. Retrying with --legacy-peer-deps in background...',
    );

    return new Promise<InstallResult>((resolve) => {
      const proc = spawn(
        'npm',
        ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'],
        {
          cwd: this.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
        },
      );

      this.baseProc = proc;
      let stderrBuf = '';
      proc.stderr?.on('data', (c) => {
        stderrBuf += c.toString();
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
      });

      proc.on('close', (code) => {
        this.finishedAt = Date.now();
        if (code === 0) {
          this.status = 'ready';
          resolve({ ok: true, durationMs: this.finishedAt - this.startedAt });
        } else {
          this.status = 'failed';
          this.baseError =
            stderrBuf || originalStderr || `npm install exited ${code}`;
          resolve({
            ok: false,
            error: this.baseError,
            durationMs: this.finishedAt - this.startedAt,
          });
        }
      });

      proc.on('error', (err) => {
        this.status = 'failed';
        this.baseError = err.message;
        this.finishedAt = Date.now();
        resolve({
          ok: false,
          error: err.message,
          durationMs: this.finishedAt - this.startedAt,
        });
      });
    });
  }

  /**
   * Current snapshot of the install state. Cheap — no waiting.
   * The agent can check this to decide whether to defer `runCommand`.
   */
  getStatus(): InstallStatus {
    return this.status;
  }

  /**
   * Human-readable progress summary for the agent.
   * Used to feed install state into tool results so the model can reason about it.
   */
  getStatusSummary(): string {
    const elapsed = this.startedAt
      ? Math.round(((this.finishedAt || Date.now()) - this.startedAt) / 1000)
      : 0;

    switch (this.status) {
      case 'pending':
        return 'Dependency installation has not started yet.';
      case 'installing':
        return `Dependency installation is still running in the background (${elapsed}s elapsed). You can continue writing files — just defer any \`npx expo install\` calls until the end.`;
      case 'ready':
        return `Dependencies are ready (installed in ${elapsed}s).`;
      case 'failed':
        return `Dependency installation failed: ${this.baseError ?? 'unknown error'}. You may continue writing files, but \`npx expo install\` will not work.`;
    }
  }

  /**
   * Await the base install — blocks until it's done (success or failure).
   * Safe to call multiple times; always resolves with the same result.
   */
  async awaitBaseInstall(): Promise<InstallResult> {
    if (!this.basePromise) {
      throw new Error('Base install was never started');
    }
    return this.basePromise;
  }

  /**
   * Run a serialized install command (e.g. `npx expo install expo-camera`).
   * - Awaits the base install first
   * - Queues behind any previous serialized installs via a mutex so we
   *   never have two npm processes mutating node_modules at once
   * - Returns stdout/stderr for the agent to consume
   */
  async runDependentCommand(
    command: string,
    timeoutMs = 180_000,
  ): Promise<{ ok: boolean; output: string }> {
    // Wait for base install to finish before running any npm/npx command.
    // If the base install failed, we still try — the user might have a
    // partially-populated node_modules that works for simple additions.
    const baseResult = await this.awaitBaseInstall();
    if (!baseResult.ok) {
      return {
        ok: false,
        output: `Cannot run "${command}" — base npm install failed: ${baseResult.error}`,
      };
    }

    // Serialize via mutex
    const run = async () => {
      return new Promise<{ ok: boolean; output: string }>((resolve) => {
        const proc = spawn(command, {
          cwd: this.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
        });

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (c) => {
          stdout += c.toString();
          if (stdout.length > 16384) stdout = stdout.slice(-8192);
        });
        proc.stderr?.on('data', (c) => {
          stderr += c.toString();
          if (stderr.length > 16384) stderr = stderr.slice(-8192);
        });

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
        }, timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timer);
          const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
          resolve({
            ok: code === 0,
            output:
              combined ||
              (code === 0
                ? '(command completed)'
                : `command exited with ${code}`),
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, output: `spawn error: ${err.message}` });
        });
      });
    };

    const next = this.mutex.then(run, run);
    this.mutex = next.catch(() => undefined); // don't let rejection poison the chain
    return next;
  }

  /**
   * Kill any in-flight install. Used by SIGINT handlers.
   */
  abort(): void {
    this.aborted = true;
    if (this.baseProc && !this.baseProc.killed) {
      try {
        this.baseProc.kill('SIGTERM');
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Print a one-line status marker — called from the command layer
   * so the user sees what's happening without cluttering agent output.
   */
  printReadyBanner(): void {
    if (this.status === 'ready') {
      const seconds = Math.round((this.finishedAt - this.startedAt) / 1000);
      log.success(
        chalk.dim('Background: ') +
          chalk.green(`dependencies installed (${seconds}s)`),
      );
    } else if (this.status === 'failed') {
      log.warn(
        chalk.dim('Background: ') +
          chalk.red(`dependency install failed — ${this.baseError}`),
      );
    }
  }
}
