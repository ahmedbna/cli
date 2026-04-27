// src/utils/runProcess.ts
//
// Shared helpers for running shell commands during the build / finalization
// pipeline. Both the orchestrator's between-phase backend setup and
// build.ts's finalization use these.

import { spawn } from 'child_process';
import chalk from 'chalk';
import { startSpinner, stopActiveSpinner } from './liveSpinner.js';
import { log } from './logger.js';

/**
 * Run an interactive shell command (inherits stdio so the user can answer
 * any prompts the command emits, e.g. `npx convex dev --once` asking for
 * a project name).
 */
export function runInteractive(command: string, cwd: string): Promise<boolean> {
  stopActiveSpinner();
  return new Promise((resolve) => {
    const proc = spawn(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Run a non-interactive command and stream its output above an animated
 * spinner. Useful for commands that the user doesn't need to interact with
 * but where seeing progress is helpful (e.g. `npx convex env set X "..."`).
 */
export async function runStreamed(
  command: string,
  cwd: string,
  label: string,
  timeoutMs = 600_000,
): Promise<{ ok: boolean; output: string }> {
  const spinner = startSpinner(chalk.magenta(label));
  return new Promise((resolve) => {
    const proc = spawn(command, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
    let captured = '';
    let buf = '';
    const handle = (chunk: Buffer) => {
      const text = chunk.toString();
      captured += text;
      if (captured.length > 32_000) captured = captured.slice(-16_000);
      buf += text;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (line) spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(line));
      }
    };
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);

    const timer = setTimeout(() => {
      spinner.writeAbove(chalk.red('    │ (timeout — killing process)'));
      try {
        proc.kill('SIGTERM');
      } catch {
        /* noop */
      }
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim())
        spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(buf.trim()));
      if (code === 0) {
        spinner.succeed(chalk.green(label + ' ✓'));
        resolve({ ok: true, output: captured.trim() });
      } else {
        spinner.fail(chalk.red(label + ` (exit ${code})`));
        resolve({ ok: false, output: captured.trim() });
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      spinner.fail(chalk.red(label + ` (${err.message})`));
      resolve({ ok: false, output: err.message });
    });
  });
}

/**
 * Wait for the background `npm install` to finish, with a visible spinner.
 * Used between the architect and backend phases so the backend agent has
 * dependencies available before it starts running commands.
 */
export async function waitForInstall(installManager: {
  getStatus: () => 'pending' | 'installing' | 'ready' | 'failed';
  awaitBaseInstall: () => Promise<{ ok: boolean; durationMs: number; error?: string }>;
}): Promise<void> {
  const status = installManager.getStatus();
  if (status === 'ready') return;
  if (status === 'failed') {
    log.warn('Background npm install failed — continuing without it.');
    return;
  }

  const spinner = startSpinner(
    chalk.cyan('Waiting for background dependency install to finish'),
  );
  const result = await installManager.awaitBaseInstall();
  if (result.ok) {
    const seconds = Math.round(result.durationMs / 1000);
    spinner.succeed(chalk.green(`Dependencies installed (${seconds}s)`));
  } else {
    spinner.fail(chalk.red('npm install failed'));
  }
}
