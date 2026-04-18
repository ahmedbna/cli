// src/utils/tsCheck.ts
//
// Runs a full TypeScript check across the project and, if errors are found,
// invokes a small "fix-it" loop that asks the AI agent to repair them.
//
// Design:
//   - Runs `npx tsc --noEmit` with the project's local tsconfig.
//   - Parses compiler diagnostics.
//   - If errors exist, spawns a bounded agent loop (max 3 rounds) with
//     a focused system prompt: "you have these TS errors, fix them."
//   - Re-runs `tsc` after each round. Stops when zero errors OR max rounds.
//
// The autofix loop uses the SAME InstallManager-backed tool belt as the
// main agent — so it can view/edit files directly. It deliberately limits
// itself to editing files (no new installs) to stay focused.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { log } from './logger.js';
import { startSpinner } from './liveSpinner.js';
import type { InstallManager } from './installManager.js';
import { runAgent } from '../agent/agent.js';

const MAX_FIX_ROUNDS = 3;

interface TsDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Run `tsc --noEmit` and return parsed diagnostics.
 * Streams live compiler output via the provided spinner callback.
 */
export async function runTypeCheck(
  projectRoot: string,
  onLine?: (line: string) => void,
): Promise<{ diagnostics: TsDiagnostic[]; raw: string }> {
  return new Promise((resolve) => {
    // Use the project's local typescript if available; fall back to npx
    const localTsc = path.join(
      projectRoot,
      'node_modules',
      '.bin',
      path.sep === '\\' ? 'tsc.cmd' : 'tsc',
    );
    const useLocal = fs.existsSync(localTsc);
    const cmd = useLocal
      ? `"${localTsc}" --noEmit --pretty false`
      : 'npx --yes tsc --noEmit --pretty false';

    const proc = spawn(cmd, {
      cwd: projectRoot,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });

    let captured = '';
    let lineBuf = '';

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      captured += text;
      if (captured.length > 128_000) captured = captured.slice(-64_000);
      lineBuf += text;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (line && onLine) onLine(line);
      }
    };

    proc.stdout?.on('data', handleChunk);
    proc.stderr?.on('data', handleChunk);

    proc.on('close', () => {
      if (lineBuf.trim() && onLine) onLine(lineBuf.trim());
      resolve({
        diagnostics: parseTscOutput(captured),
        raw: captured,
      });
    });

    proc.on('error', (err) => {
      resolve({
        diagnostics: [
          {
            file: '(tsc)',
            line: 0,
            column: 0,
            code: 'TSC_SPAWN',
            severity: 'error',
            message: `Failed to run tsc: ${err.message}`,
          },
        ],
        raw: err.message,
      });
    });
  });
}

/**
 * Parse tsc's plain output. Each error looks like:
 *   path/to/file.ts(10,5): error TS2304: Cannot find name 'Foo'.
 */
function parseTscOutput(output: string): TsDiagnostic[] {
  const diagnostics: TsDiagnostic[] = [];
  const lines = output.split('\n');
  const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS(\d+):\s*(.+)$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    diagnostics.push({
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      code: `TS${m[5]}`,
      severity: m[4] as 'error' | 'warning',
      message: m[6],
    });
  }
  return diagnostics;
}

/**
 * Format diagnostics into a compact error report for the fix-it agent.
 * Groups by file so the agent sees related errors together.
 */
function formatForAgent(diagnostics: TsDiagnostic[]): string {
  const byFile = new Map<string, TsDiagnostic[]>();
  for (const d of diagnostics) {
    if (d.severity !== 'error') continue;
    const arr = byFile.get(d.file) ?? [];
    arr.push(d);
    byFile.set(d.file, arr);
  }

  const sections: string[] = [];
  for (const [file, diags] of byFile) {
    const lines = diags
      .slice(0, 10) // cap per file
      .map((d) => `  L${d.line}:${d.column} [${d.code}] ${d.message}`);
    sections.push(`${file}\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

/**
 * Full pipeline: run tsc, and if errors exist, invoke the agent to fix them.
 * Returns true if the project ends up with zero TS errors.
 */
export async function typeCheckAndFix(opts: {
  projectRoot: string;
  installManager: InstallManager;
  stack: 'expo' | 'expo-convex';
  authToken?: string;
}): Promise<boolean> {
  const { projectRoot, installManager, stack, authToken } = opts;

  for (let attempt = 1; attempt <= MAX_FIX_ROUNDS + 1; attempt++) {
    const spinner = startSpinner(
      chalk.cyan(
        `TypeScript check ${attempt === 1 ? '' : `(verify, attempt ${attempt})`}`,
      ),
    );

    const { diagnostics, raw } = await runTypeCheck(projectRoot, (line) =>
      spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(line)),
    );

    const errors = diagnostics.filter((d) => d.severity === 'error');

    if (errors.length === 0) {
      spinner.succeed(chalk.green('TypeScript check passed — no errors'));
      return true;
    }

    spinner.fail(
      chalk.red(
        `TypeScript: ${errors.length} error${errors.length === 1 ? '' : 's'} in ${new Set(errors.map((e) => e.file)).size} file${new Set(errors.map((e) => e.file)).size === 1 ? '' : 's'}`,
      ),
    );

    if (attempt > MAX_FIX_ROUNDS) {
      log.warn(
        `Reached max autofix rounds (${MAX_FIX_ROUNDS}). ` +
          `${errors.length} TypeScript error(s) remain — review manually.`,
      );
      // Surface a short preview so the user knows what's left
      for (const e of errors.slice(0, 5)) {
        log.info(
          chalk.dim(`  ${e.file}:${e.line} `) +
            chalk.red(e.code) +
            ' ' +
            chalk.dim(e.message),
        );
      }
      if (errors.length > 5) {
        log.info(chalk.dim(`  ... and ${errors.length - 5} more`));
      }
      return false;
    }

    // Ask the agent to fix the errors
    log.info(
      chalk.yellow(
        `Attempting to fix TypeScript errors (round ${attempt}/${MAX_FIX_ROUNDS})...`,
      ),
    );

    const report = formatForAgent(errors);
    const fixPrompt =
      `The project has TypeScript compilation errors that must be fixed. ` +
      `Do NOT add new features, change behavior, or install new packages. ` +
      `Only repair the listed type errors with minimal, surgical edits.\n\n` +
      `Use viewFile to inspect each affected file before editing. ` +
      `Prefer editFile over createFile. Do NOT rewrite entire files.\n\n` +
      `When done, stop — a separate verification pass will re-run tsc.\n\n` +
      `### Errors to fix\n\n${report}\n\n` +
      `### Raw tsc tail (for extra context)\n\n` +
      raw.slice(-2000);

    try {
      await runAgent({
        projectRoot,
        prompt: fixPrompt,
        stack,
        authToken,
        installManager,
      });
    } catch (err: any) {
      log.warn(`Autofix agent failed: ${err.message ?? 'unknown error'}`);
      return false;
    }
  }

  return false;
}
