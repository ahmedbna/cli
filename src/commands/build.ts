// src/commands/build.ts
//
// Parallelized build workflow:
//
//   Phase 1: Setup             (sequential, fast)
//     - Auth validation
//     - Credit check
//     - Project name/stack/prompt prompts
//     - Template copy
//
//   Phase 2: Parallel Execution (the big win)
//     - npm install runs in the background via InstallManager
//     - AI agent runs concurrently, writing files
//     - Agent's `runCommand` calls wait for install as needed
//
//   Phase 3: Finalization       (sequential, after agent + install both done)
//     - Convex project init (interactive)
//     - Convex auth setup (interactive)
//     - Apply queued environment variables
//     - Final deploy
//     - Start dev servers
//
// Interrupt handling: SIGINT aborts all in-flight work cleanly. Partial state
// is preserved — the scaffolded project and any generated files remain on disk.

import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { spawn, spawnSync } from 'child_process';
import { log } from '../utils/logger.js';
import { ensureValidAuth, revalidateAuth } from '../utils/auth.js';
import { checkCredits } from '../utils/credits.js';
import { runAgent } from '../agent/agent.js';
import { InstallManager } from '../utils/installManager.js';
import { getPendingEnvVars, clearPendingEnvVars } from '../agent/tools.js';

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

function runInteractive(command: string, cwd: string): boolean {
  try {
    const result = spawnSync(command, {
      cwd,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ─── Main command ────────────────────────────────────────────────────────────

export async function generateCommand(options: GenerateOptions): Promise<void> {
  log.banner();

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Setup — fast, sequential, no heavy I/O
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
  log.info('Initializing the app...');
  try {
    const templateDir = resolveTemplateDir(stack);
    if (!fs.existsSync(projectRoot)) {
      fs.mkdirSync(projectRoot, { recursive: true });
    }
    copyTemplateDir(templateDir, projectRoot);
    log.success(`App initialized at: ${chalk.cyan(projectRoot)}`);
  } catch (err: any) {
    log.error(`Failed to initialize the app: ${err.message}`);
    process.exit(1);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 2: PARALLEL — npm install runs concurrently with the AI agent
  // ════════════════════════════════════════════════════════════════════════

  const installManager = new InstallManager(projectRoot);

  // If the user passed --no-install, skip the background install entirely.
  // This is mainly useful for testing or when the user wants to inspect the
  // scaffolded project before dependencies resolve. Agent can still run —
  // any `runCommand` with npm/npx will fail with a clear error.
  const skipInstall = options.install === false;
  const skipRun = options.run === false;

  // Register a SIGINT handler for the parallel phase. This fires BEFORE the
  // agent's own handler (agent registers later), so we need it to do full
  // cleanup: abort install, then exit. Once the agent registers its handler
  // we remove this one to avoid double-exit logic.
  let parallelSigintActive = true;
  const parallelSigint = () => {
    if (!parallelSigintActive) return;
    parallelSigintActive = false;
    console.log();
    log.warn('Interrupted. Aborting background install...');
    installManager.abort();
    log.info(
      'Your scaffolded project is preserved at ' + chalk.cyan(projectRoot),
    );
    process.exit(130); // 128 + SIGINT(2)
  };
  process.on('SIGINT', parallelSigint);
  process.on('SIGTERM', parallelSigint);

  log.divider();
  log.info(chalk.bold('Starting parallel phase'));
  log.info(chalk.dim('  • npm install — running in background'));
  log.info(chalk.dim('  • AI agent    — starting now'));
  log.divider();

  // Kick off the background install FIRST so it has a head start while
  // the agent boots up and makes its first network round trip.
  // Honor --no-install for debug/test scenarios.
  if (skipInstall) {
    log.warn(
      '--no-install: skipping background npm install. ' +
        'Any `npx expo install` from the agent will fail.',
    );
  } else {
    installManager.startBaseInstall();
  }

  // Start the agent. The agent registers its OWN SIGINT handler on entry;
  // we deactivate ours so we don't double-exit. We still keep it registered
  // in case the agent exits abnormally without removing its listener.
  const freshToken = await revalidateAuth();

  // Hand off signal responsibility to the agent: it will handle cleanup
  // and exit. We mark ours inactive so it becomes a no-op but stays
  // registered as a safety net.
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
    installManager.abort();
    process.removeListener('SIGINT', parallelSigint);
    process.removeListener('SIGTERM', parallelSigint);
    log.error(`Agent failed: ${err.message ?? 'unknown error'}`);
    log.warn(
      'Your scaffolded project is preserved at ' + chalk.cyan(projectRoot),
    );
    process.exit(1);
  }

  // Agent finished cleanly — reactivate our handler to cover Phase 3.
  parallelSigintActive = true;

  // ── Synchronization point: wait for the background install to finish ───
  // By the time the agent finishes, the install has usually already completed
  // (it's only ~45s vs ~2-4 min of generation). But we still await to be safe.
  if (!skipInstall) {
    log.info('Ensuring dependencies finished installing...');
    const installResult = await installManager.awaitBaseInstall();
    installManager.printReadyBanner();

    if (!installResult.ok) {
      log.warn(
        'Base npm install failed. You can retry manually with:\n' +
          '  ' +
          chalk.cyan(`cd ${projectRoot} && npm install --legacy-peer-deps`),
      );
      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with Convex setup anyway?',
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
  }

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3: Finalization — deferred Convex setup + env vars + dev servers
  // ════════════════════════════════════════════════════════════════════════

  if (stack === 'expo-convex') {
    console.log();
    log.divider();
    log.info(chalk.bold('Finalizing — Convex setup'));
    log.info(
      chalk.dim(
        'Code generation is complete. Now we set up the Convex backend and auth.',
      ),
    );
    log.divider();

    console.log();
    log.info(chalk.bold('Step 1/3 — Initialize Convex project'));
    log.info(
      chalk.dim(
        'Select your team, enter a project name, and choose deployment type.',
      ),
    );
    console.log();

    const convexInitOk = runInteractive('npx convex dev --once', projectRoot);

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

    console.log();
    log.info(chalk.bold('Step 2/3 — Configure Convex Auth'));
    log.info(
      chalk.dim('This configures JWT keys and validates your auth setup.'),
    );
    console.log();

    const authInitOk = runInteractive('npx @convex-dev/auth', projectRoot);
    if (!authInitOk) {
      log.warn(
        'Convex Auth setup did not complete.\n' +
          `  You can run ${chalk.cyan('npx @convex-dev/auth')} manually later.`,
      );
    } else {
      log.success('Convex Auth configured.');
    }

    // ── Apply queued environment variables ──────────────────────────────
    const pendingEnvs = getPendingEnvVars();
    if (pendingEnvs.length > 0) {
      console.log();
      log.info(chalk.bold('Step 3/3 — Environment variables'));
      log.info(
        chalk.dim(
          'The agent requested the following environment variables for this app:',
        ),
      );
      for (const name of pendingEnvs) {
        log.info('  • ' + chalk.yellow(name));
      }
      console.log();
      log.info(
        'For each one, either:\n' +
          `  1. Set it in the Convex dashboard → ${chalk.cyan('Settings → Environment Variables')}\n` +
          `  2. Or run: ${chalk.cyan(`npx convex env set <NAME> <value>`)}\n`,
      );

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
            const ok = runInteractive(cmd, projectRoot);
            if (ok) log.success(`Set ${name}`);
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

    // ── Final deploy: includes everything the agent wrote + any env vars ─
    console.log();
    log.info('Deploying final state to Convex...');
    const finalDeployOk = runInteractive('npx convex dev --once', projectRoot);
    if (finalDeployOk) log.success('Backend deployed.');
    else {
      log.warn(
        'Final deploy failed. You may need to fix schema errors and run ' +
          chalk.cyan('npx convex dev') +
          ' manually.',
      );
    }
  } else {
    // Stack is 'expo' only — no Convex work. Still respect queued env vars
    // by informing the user.
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
  }

  // ── Deactivate SIGINT handler — all critical work is done ──────────────
  parallelSigintActive = false;
  process.removeListener('SIGINT', parallelSigint);
  process.removeListener('SIGTERM', parallelSigint);

  // ── Start dev servers ─────────────────────────────────────────────────
  const expoCommand = isMacOS() ? 'npx expo run:ios' : 'npx expo run:android';
  const platform = isMacOS() ? 'iOS' : 'Android';

  if (skipRun) {
    console.log();
    log.divider();
    log.success(chalk.bold('Your app is ready!'));
    log.info(chalk.dim('--no-run: skipping dev server launch.'));
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
    console.log();
    log.info('Starting Convex dev server (background)...');
    const convexDevProc = spawn('npx', ['convex', 'dev'], {
      cwd: projectRoot,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: true,
    });
    convexDevProc.unref();
    log.success('Convex dev server running in background.');
  }

  console.log();
  log.info(`Starting Expo dev build for ${chalk.cyan(platform)}...`);
  log.info(chalk.dim(`Running: ${expoCommand}`));
  console.log();

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
