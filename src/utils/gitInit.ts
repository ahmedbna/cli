// src/utils/gitInit.ts
//
// Initialize a git repository, stage all files, and create the first commit.
// Streams each subcommand's output live so the user sees progress.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { log } from './logger.js';
import { startSpinner } from './liveSpinner.js';

async function runGit(
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        // Suppress the "hint: Using 'master' as the name..." noise
        GIT_CONFIG_PARAMETERS: "'init.defaultBranch=main'",
      },
    });

    let captured = '';
    let buf = '';

    const handle = (chunk: Buffer) => {
      const text = chunk.toString();
      captured += text;
      if (captured.length > 16_000) captured = captured.slice(-8000);
      buf += text;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (line && onLine) onLine(line);
      }
    };

    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);

    proc.on('error', (err) => {
      resolve({ ok: false, code: null, output: err.message });
    });
    proc.on('close', (code) => {
      if (buf.trim() && onLine) onLine(buf.trim());
      resolve({ ok: code === 0, code, output: captured.trim() });
    });
  });
}

/**
 * Initialize git in the project if it isn't already a repo, then stage
 * and commit everything with message "bna".
 */
export async function initGitRepo(projectRoot: string): Promise<boolean> {
  const spinner = startSpinner(chalk.cyan('Initializing git repository'));
  const streamLine = (prefix: string) => (line: string) =>
    spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(`${prefix} ${line}`));

  // Skip init if .git already exists
  const gitDir = path.join(projectRoot, '.git');
  const alreadyInitialized = fs.existsSync(gitDir);

  if (!alreadyInitialized) {
    spinner.update(chalk.cyan('Initializing git repository — git init'));
    const init = await runGit(
      ['init', '-b', 'main'],
      projectRoot,
      streamLine('git init:'),
    );
    if (!init.ok) {
      // Try without -b flag in case of older git
      const fallback = await runGit(
        ['init'],
        projectRoot,
        streamLine('git init:'),
      );
      if (!fallback.ok) {
        spinner.fail(chalk.red('git init failed'));
        log.warn(
          chalk.dim(fallback.output || init.output || 'unknown git error'),
        );
        return false;
      }
    }
  } else {
    spinner.writeAbove(
      chalk.dim('    │ ') +
        chalk.dim('existing .git directory found — skipping git init'),
    );
  }

  // Stage everything
  spinner.update(chalk.cyan('Staging files — git add .'));
  const add = await runGit(['add', '.'], projectRoot, streamLine('git add:'));
  if (!add.ok) {
    spinner.fail(chalk.red('git add failed'));
    log.warn(chalk.dim(add.output || 'unknown git error'));
    return false;
  }

  // Check if there's anything to commit (e.g. already clean on re-run)
  const status = await runGit(
    ['status', '--porcelain'],
    projectRoot,
    undefined,
  );
  if (status.ok && status.output.trim().length === 0) {
    spinner.succeed(chalk.green('Git: working tree clean — nothing to commit'));
    return true;
  }

  // Ensure a committer identity exists — otherwise `git commit` errors out
  // on fresh machines. We set a repo-local fallback only if none is set.
  const nameCheck = await runGit(['config', 'user.name'], projectRoot);
  if (!nameCheck.ok || !nameCheck.output.trim()) {
    await runGit(
      ['config', 'user.name', 'BNA CLI'],
      projectRoot,
      streamLine('git config:'),
    );
  }
  const emailCheck = await runGit(['config', 'user.email'], projectRoot);
  if (!emailCheck.ok || !emailCheck.output.trim()) {
    await runGit(
      ['config', 'user.email', 'cli@ahmedbna.com'],
      projectRoot,
      streamLine('git config:'),
    );
  }

  // Commit
  spinner.update(chalk.cyan('Committing — git commit -m "bna"'));
  const commit = await runGit(
    ['commit', '-m', 'bna'],
    projectRoot,
    streamLine('git commit:'),
  );
  if (!commit.ok) {
    spinner.fail(chalk.red('git commit failed'));
    log.warn(chalk.dim(commit.output || 'unknown git error'));
    return false;
  }

  spinner.succeed(chalk.green('Git repository initialized and committed'));
  return true;
}
