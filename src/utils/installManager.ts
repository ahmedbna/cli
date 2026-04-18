// src/utils/installManager.ts
//
// Manages background dependency installation while the AI agent runs in parallel.
//
// Streaming additions:
//   - runDependentCommand accepts an `onLine` callback so callers can stream
//     stdout/stderr to the terminal in real time (via their spinner).
//   - runDependentCommand accepts an `onStart` callback that fires when the
//     command actually begins running (i.e. base install has finished and
//     our serialized slot has opened), so the UI can flip from "waiting"
//     to "running".
//   - The base npm install progress is surfaced through the Phase 2 banner
//     and an optional onLine stream if callers want it.

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
  private aborted = false;
  /** Listeners for base install progress lines. */
  private baseLineListeners = new Set<(line: string) => void>();

  constructor(private projectRoot: string) {}

  /** Subscribe to live stdout/stderr lines from the base npm install. */
  onBaseInstallLine(listener: (line: string) => void): () => void {
    this.baseLineListeners.add(listener);
    return () => this.baseLineListeners.delete(listener);
  }

  private emitBaseLine(line: string): void {
    for (const l of this.baseLineListeners) {
      try {
        l(line);
      } catch {
        /* noop */
      }
    }
  }

  startBaseInstall(): void {
    if (this.basePromise) return;

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
      let stdoutLineBuf = '';
      let stderrLineBuf = '';

      const flushLines = (
        buf: string,
        chunk: string,
      ): { remainder: string; lines: string[] } => {
        const combined = buf + chunk;
        const parts = combined.split('\n');
        const remainder = parts.pop() ?? '';
        return { remainder, lines: parts };
      };

      proc.stdout?.on('data', (chunk) => {
        const { remainder, lines } = flushLines(
          stdoutLineBuf,
          chunk.toString(),
        );
        stdoutLineBuf = remainder;
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) this.emitBaseLine(trimmed);
        }
      });

      proc.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
        const { remainder, lines } = flushLines(stderrLineBuf, text);
        stderrLineBuf = remainder;
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) this.emitBaseLine(trimmed);
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
          this.status = 'failed';
          this.baseError = 'aborted by user';
          resolve({
            ok: false,
            error: 'aborted',
            durationMs: this.finishedAt - this.startedAt,
          });
        } else {
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
      let stdoutLineBuf = '';
      let stderrLineBuf = '';

      const emitLines = (buf: string, chunk: string): string => {
        const combined = buf + chunk;
        const parts = combined.split('\n');
        const remainder = parts.pop() ?? '';
        for (const line of parts) {
          const trimmed = line.trimEnd();
          if (trimmed) this.emitBaseLine(trimmed);
        }
        return remainder;
      };

      proc.stdout?.on('data', (c) => {
        stdoutLineBuf = emitLines(stdoutLineBuf, c.toString());
      });
      proc.stderr?.on('data', (c) => {
        const text = c.toString();
        stderrBuf += text;
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
        stderrLineBuf = emitLines(stderrLineBuf, text);
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

  getStatus(): InstallStatus {
    return this.status;
  }

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

  async awaitBaseInstall(): Promise<InstallResult> {
    if (!this.basePromise) {
      throw new Error('Base install was never started');
    }
    return this.basePromise;
  }

  /**
   * Run a serialized dependent command (e.g. `npx expo install expo-camera`).
   *
   * @param command  Shell command to run
   * @param timeoutMs  Kill the command after this long
   * @param onLine  Called for each complete line of stdout/stderr
   * @param onStart  Called once the command actually starts (post-wait)
   */
  async runDependentCommand(
    command: string,
    timeoutMs = 180_000,
    onLine?: (line: string) => void,
    onStart?: () => void,
  ): Promise<{ ok: boolean; output: string }> {
    const baseResult = await this.awaitBaseInstall();
    if (!baseResult.ok) {
      return {
        ok: false,
        output: `Cannot run "${command}" — base npm install failed: ${baseResult.error}`,
      };
    }

    const run = async () => {
      if (onStart) {
        try {
          onStart();
        } catch {
          /* noop */
        }
      }
      return new Promise<{ ok: boolean; output: string }>((resolve) => {
        const proc = spawn(command, {
          cwd: this.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
          env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
        });

        let captured = '';
        let stdoutBuf = '';
        let stderrBuf = '';

        const emit = (buf: string, chunk: string): string => {
          const combined = buf + chunk;
          const parts = combined.split('\n');
          const remainder = parts.pop() ?? '';
          for (const line of parts) {
            const trimmed = line.trimEnd();
            if (!trimmed) continue;
            if (onLine) {
              try {
                onLine(trimmed);
              } catch {
                /* noop */
              }
            }
          }
          return remainder;
        };

        proc.stdout?.on('data', (c) => {
          const text = c.toString();
          captured += text;
          if (captured.length > 32_000) captured = captured.slice(-16_000);
          stdoutBuf = emit(stdoutBuf, text);
        });
        proc.stderr?.on('data', (c) => {
          const text = c.toString();
          captured += text;
          if (captured.length > 32_000) captured = captured.slice(-16_000);
          stderrBuf = emit(stderrBuf, text);
        });

        const timer = setTimeout(() => {
          if (onLine) onLine('(timeout — killing process)');
          try {
            proc.kill('SIGTERM');
          } catch {
            /* noop */
          }
        }, timeoutMs);

        proc.on('close', (code) => {
          clearTimeout(timer);
          // Flush trailing partial lines
          if (stdoutBuf.trim() && onLine) onLine(stdoutBuf.trim());
          if (stderrBuf.trim() && onLine) onLine(stderrBuf.trim());
          resolve({
            ok: code === 0,
            output:
              captured.trim() ||
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
    this.mutex = next.catch(() => undefined);
    return next;
  }

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
