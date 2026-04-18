// src/commands/build.ts
//
// Build workflow:
//
//   Phase 1: Setup (sequential, fast)
//     - Auth validation
//     - Credit check
//     - Project name/stack/prompt prompts
//     - Template copy
//
//   Phase 2: Parallel Execution
//     - `npm install` runs in the background (streamed live above the spinner)
//     - AI agent runs concurrently, writing files (every action shown in real time)
//
//   Phase 3: Finalization (sequential, in this exact order)
//     1. Convex project init       — `npx convex dev --once`
//     2. Full TypeScript check     — `tsc --noEmit`, auto-fix errors with agent
//     3. Git init + add + commit   — `git init`, `git add .`, `git commit -m "bna"`
//     4. Convex Auth setup         — `npx @convex-dev/auth`, apply env vars, final deploy
//     5. Launch the app            — `npx expo run:ios` / `npx expo run:android`
//
// Every long-running step streams output live so the terminal never appears idle.

import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { spawn } from 'child_process';
import { log } from '../utils/logger.js';
import { ensureValidAuth, revalidateAuth } from '../utils/auth.js';
import { checkCredits } from '../utils/credits.js';
import { runAgent } from '../agent/agent.js';
import { InstallManager } from '../utils/installManager.js';
import { getPendingEnvVars, clearPendingEnvVars } from '../agent/tools.js';
import { startSpinner, stopActiveSpinner } from '../utils/liveSpinner.js';
import { typeCheckAndFix } from '../utils/tsCheck.js';
import { initGitRepo } from '../utils/gitInit.js';

interface GenerateOptions {
  prompt?: string;
  name?: string;
  stack?: string;
  install?: boolean;
  run?: boolean;
  skills?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function copyTemplateDir(src: string, dest: string): void {
  const SKIP = new Set([
    'node_modules',
    '.git',
    '.expo',
    '_generated',
    'ios',
    'android',
  ]);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTemplateDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function resolveTemplateDir(stack: string): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'templates', stack);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  const cwdCandidate = path.join(process.cwd(), 'templates', stack);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  throw new Error(`Template directory not found for stack "${stack}".`);
}

function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

/**
 * Run a command interactively (inherits stdio) — used when we WANT the user
 * to see and interact with prompts directly, e.g. Convex team selection.
 *
 * IMPORTANT: no spinner should be active when this runs — it will corrupt
 * the interactive output.
 */
function runInteractive(command: string, cwd: string): Promise<boolean> {
  // Ensure no spinner is on screen
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
 * Run a command and stream its output live above a spinner.
 * Used for non-interactive commands where we want continuous feedback.
 */
async function runStreamed(
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

// ─── Main command ────────────────────────────────────────────────────────────

export async function generateCommand(options: GenerateOptions): Promise<void> {
  log.banner();

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Setup
  // ════════════════════════════════════════════════════════════════════════

  await ensureValidAuth();

  log.info('Checking credits...');
  const { credits, hasEnough } = await checkCredits();

  if (!hasEnough) {
    log.error(
      `Insufficient credits (${credits} remaining).\n` +
        `  Visit ${chalk.cyan('https://ai.ahmedbna.com/credits')} to purchase more credits.`,
    );
    return;
  }
  if (credits >= 0) log.credits(credits);

  const cwd = process.cwd();
  const dirContents = fs.readdirSync(cwd);
  const isEmpty =
    dirContents.length === 0 ||
    dirContents.every((f) => f.startsWith('.') || f === 'node_modules');

  let projectName: string;
  let projectRoot: string;

  if (options.name) {
    projectName = options.name;
    projectRoot = path.resolve(cwd, projectName);
  } else if (isEmpty) {
    projectName = path.basename(cwd);
    projectRoot = cwd;
    log.info(`Using current directory as project: ${chalk.cyan(projectName)}`);
  } else {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: 'my-bna-app',
        validate: (input: string) =>
          /^[a-z0-9_-]+$/i.test(input) ||
          'Use only letters, numbers, hyphens, underscores',
      },
    ]);
    projectName = answers.projectName;
    projectRoot = path.resolve(cwd, projectName);
  }

  let stack: 'expo' | 'expo-convex';
  if (options.stack === 'expo') stack = 'expo';
  else if (options.stack === 'expo-convex') stack = 'expo-convex';
  else {
    const stackAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'stack',
        message: 'Choose your stack:',
        choices: [
          {
            name: `${chalk.yellow('Expo + Convex')} ${chalk.dim('— Full-stack with real-time backend')}`,
            value: 'expo-convex',
          },
          {
            name: `${chalk.yellow('Expo only')} ${chalk.dim('— React Native frontend only')}`,
            value: 'expo',
          },
        ],
        default: 'expo-convex',
      },
    ]);
    stack = stackAnswer.stack;
  }

  let prompt: string;
  if (options.prompt) prompt = options.prompt;
  else {
    const promptAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'prompt',
        message: chalk.yellow('What do you want to build?'),
        validate: (input: string) =>
          input.trim().length > 0 || 'Please describe your app',
      },
    ]);
    prompt = promptAnswer.prompt;
  }

  console.log();
  log.info(`Project: ${chalk.cyan(projectName)}`);
  log.info(`Stack:   ${chalk.cyan(stack)}`);
  log.info(
    `Prompt:  ${chalk.cyan(prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt)}`,
  );
  log.info(`Path:    ${chalk.dim(projectRoot)}`);
  console.log();

  // ── Copy template (fast — ~2s) ─────────────────────────────────────────
  {
    const initSpinner = startSpinner(
      chalk.cyan('Initializing the app from template'),
    );
    try {
      const templateDir = resolveTemplateDir(stack);
      if (!fs.existsSync(projectRoot)) {
        fs.mkdirSync(projectRoot, { recursive: true });
      }
      copyTemplateDir(templateDir, projectRoot);
      initSpinner.succeed(
        chalk.green(`App initialized at ${chalk.cyan(projectRoot)}`),
      );
    } catch (err: any) {
      initSpinner.fail(chalk.red('Failed to initialize the app'));
      log.error(err.message);
      process.exit(1);
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2: PARALLEL — npm install runs concurrently with the AI agent
  // ════════════════════════════════════════════════════════════════════════

  const installManager = new InstallManager(projectRoot);
  const skipInstall = options.install === false;
  const skipRun = options.run === false;

  let parallelSigintActive = true;
  const parallelSigint = () => {
    if (!parallelSigintActive) return;
    parallelSigintActive = false;
    stopActiveSpinner();
    console.log();
    log.warn('Interrupted. Aborting background install...');
    installManager.abort();
    log.info(
      'Your scaffolded project is preserved at ' + chalk.cyan(projectRoot),
    );
    process.exit(130);
  };
  process.on('SIGINT', parallelSigint);
  process.on('SIGTERM', parallelSigint);

  log.divider();
  log.info(chalk.bold('Starting parallel phase'));
  log.info(chalk.dim('  • npm install — running in background'));
  log.info(chalk.dim('  • AI agent    — starting now'));
  log.divider();

  // Subscribe to base install progress so we can surface occasional lines
  // without drowning out agent output. We throttle to ~1 line every 3s.
  let lastInstallLineAt = 0;
  const unsubscribeInstall = installManager.onBaseInstallLine((line) => {
    const now = Date.now();
    if (now - lastInstallLineAt < 3000) return;
    lastInstallLineAt = now;
    // These arrive while the agent may be animating — use the spinner's
    // writeAbove if one is active, else just print.
    const msg = chalk.dim('  [npm install] ') + chalk.dim(line);
    // getActiveSpinner lives in liveSpinner but we keep it simple:
    // write directly — the active spinner's next tick will redraw itself.
    // Since TTY line rewrite uses \r, this may briefly flash, but it's
    // far better than the previous zero-feedback approach.
    process.stdout.write('\r\x1b[K' + msg + '\n');
  });

  if (skipInstall) {
    log.warn(
      '--no-install: skipping background npm install. ' +
        'Any `npx expo install` from the agent will fail.',
    );
  } else {
    installManager.startBaseInstall();
  }

  const freshToken = await revalidateAuth();

  parallelSigintActive = false;

  try {
    await runAgent({
      projectRoot,
      prompt,
      stack,
      authToken: freshToken,
      installManager,
    });
  } catch (err: any) {
    unsubscribeInstall();
    installManager.abort();
    process.removeListener('SIGINT', parallelSigint);
    process.removeListener('SIGTERM', parallelSigint);
    stopActiveSpinner();
    log.error(`Agent failed: ${err.message ?? 'unknown error'}`);
    log.warn(
      'Your scaffolded project is preserved at ' + chalk.cyan(projectRoot),
    );
    process.exit(1);
  }

  parallelSigintActive = true;

  // Wait for the background install to finish with a visible spinner
  if (!skipInstall) {
    const awaitSpinner = startSpinner(
      chalk.cyan('Ensuring background dependencies have finished installing'),
    );
    const installResult = await installManager.awaitBaseInstall();
    unsubscribeInstall();
    if (installResult.ok) {
      const seconds = Math.round(installResult.durationMs / 1000);
      awaitSpinner.succeed(chalk.green(`Dependencies installed (${seconds}s)`));
    } else {
      awaitSpinner.fail(chalk.red('npm install failed'));
      log.warn(
        'Base npm install failed. You can retry manually with:\n' +
          '  ' +
          chalk.cyan(`cd ${projectRoot} && npm install --legacy-peer-deps`),
      );
      stopActiveSpinner();
      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with finalization anyway?',
          default: false,
        },
      ]);
      if (!continueAnyway) {
        log.info(
          'Exiting. Fix the install issue, then run ' +
            chalk.cyan('bna build') +
            ' again in the project directory.',
        );
        return;
      }
    }
  } else {
    log.warn(
      '--no-install was set. Run ' +
        chalk.cyan(`cd ${projectRoot} && npm install`) +
        ' before starting dev servers.',
    );
    unsubscribeInstall();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Finalization — exact ordering per requirements
  //   1. Convex init
  //   2. TypeScript check + autofix
  //   3. Git init + add + commit
  //   4. Convex Auth setup + env vars + final deploy
  //   5. Launch simulator
  // ════════════════════════════════════════════════════════════════════════

  console.log();
  log.divider();
  log.info(chalk.bold('Finalizing your app'));
  log.divider();

  // ── Step 1: Convex init ────────────────────────────────────────────────
  if (stack === 'expo-convex') {
    console.log();
    log.info(chalk.bold.cyan('Step 1/5 — Initialize Convex project'));
    log.info(
      chalk.dim(
        'Select your team, enter a project name, and choose deployment type.',
      ),
    );
    console.log();

    const convexInitOk = await runInteractive(
      'npx convex dev --once',
      projectRoot,
    );

    if (!convexInitOk) {
      log.warn(
        'Convex initialization did not complete.\n' +
          `  You can retry with ${chalk.cyan('npx convex dev --once')} later.`,
      );
      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with the build anyway?',
          default: false,
        },
      ]);
      if (!continueAnyway) return;
    } else {
      log.success('Convex project initialized.');
    }
  } else {
    log.info(chalk.dim('Step 1/5 — Convex init skipped (Expo-only stack).'));
  }

  // ── Step 2: TypeScript check + autofix ─────────────────────────────────
  console.log();
  log.info(chalk.bold.cyan('Step 2/5 — TypeScript check'));
  log.info(
    chalk.dim(
      'Running a full type check. Errors will be fixed automatically where possible.',
    ),
  );
  console.log();

  const typesClean = await typeCheckAndFix({
    projectRoot,
    installManager,
    stack,
    authToken: freshToken,
  });

  if (!typesClean) {
    log.warn(
      'Some TypeScript errors remain. Continuing anyway — you can run ' +
        chalk.cyan('npx tsc --noEmit') +
        ' later to review.',
    );
  }

  // ── Step 3: Git init + commit ──────────────────────────────────────────
  console.log();
  log.info(chalk.bold.cyan('Step 3/5 — Initialize git repository'));
  console.log();

  const gitOk = await initGitRepo(projectRoot);
  if (!gitOk) {
    log.warn('Git initialization had issues — you can run git manually later.');
  }

  // ── Step 4: Convex Auth setup + env vars + final deploy ────────────────
  if (stack === 'expo-convex') {
    console.log();
    log.info(chalk.bold.cyan('Step 4/5 — Configure Convex Auth'));
    log.info(
      chalk.dim('This configures JWT keys and validates your auth setup.'),
    );
    console.log();

    const authInitOk = await runInteractive(
      'npx @convex-dev/auth',
      projectRoot,
    );
    if (!authInitOk) {
      log.warn(
        'Convex Auth setup did not complete.\n' +
          `  You can run ${chalk.cyan('npx @convex-dev/auth')} manually later.`,
      );
    } else {
      log.success('Convex Auth configured.');
    }

    // Apply queued environment variables
    const pendingEnvs = getPendingEnvVars();
    if (pendingEnvs.length > 0) {
      console.log();
      log.info(
        chalk.dim(
          'The agent requested the following environment variables for this app:',
        ),
      );
      for (const name of pendingEnvs) {
        log.info('  • ' + chalk.yellow(name));
      }
      console.log();

      const { setNow } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'setNow',
          message: 'Would you like to set these now interactively?',
          default: true,
        },
      ]);

      if (setNow) {
        for (const name of pendingEnvs) {
          const { value } = await inquirer.prompt([
            {
              type: 'password',
              name: 'value',
              message: `Value for ${chalk.yellow(name)} (leave blank to skip):`,
              mask: '*',
            },
          ]);
          if (value && value.trim().length > 0) {
            const cmd = `npx convex env set ${name} "${value.replace(/"/g, '\\"')}"`;
            const result = await runStreamed(
              cmd,
              projectRoot,
              `Setting ${name}`,
            );
            if (result.ok) log.success(`Set ${name}`);
            else log.warn(`Failed to set ${name} — set it manually later`);
          } else {
            log.info(
              chalk.dim(`Skipped ${name} — remember to set it before use`),
            );
          }
        }
      }
      clearPendingEnvVars();
    }

    // Final deploy
    console.log();
    const finalDeploy = await runStreamed(
      'npx convex dev --once',
      projectRoot,
      'Deploying final state to Convex',
      600_000,
    );
    if (finalDeploy.ok) log.success('Backend deployed.');
    else {
      log.warn(
        'Final deploy failed. You may need to fix schema errors and run ' +
          chalk.cyan('npx convex dev') +
          ' manually.',
      );
    }
  } else {
    const pendingEnvs = getPendingEnvVars();
    if (pendingEnvs.length > 0) {
      console.log();
      log.info(
        'The agent requested environment variables: ' +
          pendingEnvs.map((n) => chalk.yellow(n)).join(', '),
      );
      log.info(
        chalk.dim(
          '  Add these to your Expo app via app.json `extra` or a .env file as appropriate.',
        ),
      );
      clearPendingEnvVars();
    }
    log.info(chalk.dim('Step 4/5 — Convex Auth skipped (Expo-only stack).'));
  }

  // Deactivate SIGINT handler — all critical work is done
  parallelSigintActive = false;
  process.removeListener('SIGINT', parallelSigint);
  process.removeListener('SIGTERM', parallelSigint);

  // ── Step 5: Launch the app in the simulator ───────────────────────────
  const expoCommand = isMacOS() ? 'npx expo run:ios' : 'npx expo run:android';
  const platform = isMacOS() ? 'iOS' : 'Android';

  console.log();
  log.info(chalk.bold.cyan(`Step 5/5 — Launch app in ${platform} simulator`));
  console.log();

  if (skipRun) {
    log.info(chalk.dim('--no-run: skipping dev server launch.'));
    console.log();
    log.divider();
    log.success(chalk.bold('Your app is ready!'));
    console.log();
    if (projectRoot !== cwd) log.info(`  cd ${projectName}`);
    if (stack === 'expo-convex') {
      log.info(
        '  npx convex dev          ' + chalk.dim('# Start Convex backend'),
      );
    }
    log.info(
      `  ${expoCommand}    ` + chalk.dim(`# Start ${platform} dev build`),
    );
    console.log();
    return;
  }

  if (stack === 'expo-convex') {
    const bgSpinner = startSpinner(
      chalk.cyan('Starting Convex dev server in background'),
    );
    const convexDevProc = spawn('npx', ['convex', 'dev'], {
      cwd: projectRoot,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: true,
    });
    convexDevProc.unref();
    bgSpinner.succeed(chalk.green('Convex dev server running in background'));
  }

  console.log();
  log.info(`Starting Expo dev build for ${chalk.cyan(platform)}...`);
  log.info(chalk.dim(`Running: ${expoCommand}`));
  console.log();

  // Stop any stray spinner — the Expo CLI takes over stdin/stdout from here.
  stopActiveSpinner();

  const expoProc = spawn(expoCommand, [], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  expoProc.on('close', (code) => {
    if (code !== 0) log.warn(`Expo exited with code ${code}.`);
  });

  console.log();
  log.divider();
  log.success(chalk.bold('Your app is ready!'));
  console.log();
  if (projectRoot !== cwd) log.info(`  cd ${projectName}`);
  if (stack === 'expo-convex') {
    log.info(
      '  npx convex dev          ' +
        chalk.dim('# Convex backend (already running)'),
    );
  }
  log.info(
    `  ${expoCommand}    ` +
      chalk.dim(`# ${platform} dev build (already running)`),
  );
  console.log();
}
