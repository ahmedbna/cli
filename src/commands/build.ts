// src/commands/build.ts
//
// The build command is now context-aware:
//
//   - Empty directory (or --name given)    → scaffold a new project + run REPL
//   - Existing directory with .bna/        → resume the saved conversational session
//   - Existing directory WITHOUT .bna/     → refuse (don't clobber an unrelated project)
//
// After the first successful build turn, the user is asked whether to run
// the finalization pipeline (Convex init → tsc → git → Convex auth → expo run).
// They can also invoke it anytime with /finalize from inside the REPL.
//
// The finalization pipeline itself is unchanged from the original — just
// lifted into a helper so both the "after first build" branch and a future
// slash command can call it.

import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { spawn } from 'child_process';
import { log } from '../utils/logger.js';
import { ensureValidAuth, revalidateAuth } from '../utils/auth.js';
import { checkCredits } from '../utils/credits.js';
import { InstallManager } from '../utils/installManager.js';
import { getPendingEnvVars, clearPendingEnvVars } from '../agent/tools.js';
import { startSpinner, stopActiveSpinner } from '../utils/liveSpinner.js';
import { typeCheckAndFix } from '../utils/tsCheck.js';
import { initGitRepo } from '../utils/gitInit.js';
import { Session } from '../session/session.js';
import { runRepl } from '../session/repl.js';

interface GenerateOptions {
  prompt?: string;
  name?: string;
  stack?: string;
  install?: boolean;
  run?: boolean;
  skills?: string;
  /** Skip the "want to finalize?" prompt after the first turn */
  noFinalize?: boolean;
}

// ─── Helpers (unchanged from the original) ──────────────────────────────────

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

function runInteractive(command: string, cwd: string): Promise<boolean> {
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

// ─── Session detection ──────────────────────────────────────────────────────

function hasSavedSession(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.bna', 'session.json'));
}

function looksLikeBnaProject(projectRoot: string): boolean {
  // Heuristic: directory has package.json + app/ + (convex/ or babel.config.js)
  // If it looks like a BNA project, we don't clobber it even without .bna/.
  return (
    fs.existsSync(path.join(projectRoot, 'package.json')) &&
    fs.existsSync(path.join(projectRoot, 'app'))
  );
}

function isEmptyOrTrivial(projectRoot: string): boolean {
  if (!fs.existsSync(projectRoot)) return true;
  const contents = fs.readdirSync(projectRoot);
  return (
    contents.length === 0 ||
    contents.every((f) => f.startsWith('.') || f === 'node_modules')
  );
}

// ─── Main command ────────────────────────────────────────────────────────────

export async function generateCommand(options: GenerateOptions): Promise<void> {
  log.banner();

  // ════════════════════════════════════════════════════════════════════════
  // Phase 0: Auth + credits
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

  // ════════════════════════════════════════════════════════════════════════
  // Phase 1: Decide — resume existing session, or scaffold a new one?
  // ════════════════════════════════════════════════════════════════════════

  const cwd = process.cwd();

  // Case A: `--name` forces creating a new project in a subdirectory
  // Case B: cwd has a saved session → resume
  // Case C: cwd is empty → scaffold into cwd
  // Case D: cwd has stuff but no session → ask before clobbering

  if (!options.name && hasSavedSession(cwd)) {
    // ─── RESUME PATH ────────────────────────────────────────────────────
    await resumeSession(cwd);
    return;
  }

  // ─── SCAFFOLD PATH ──────────────────────────────────────────────────────

  let projectName: string;
  let projectRoot: string;

  if (options.name) {
    projectName = options.name;
    projectRoot = path.resolve(cwd, projectName);
    // If the target exists AND has a session, resume it instead of re-scaffolding.
    if (fs.existsSync(projectRoot) && hasSavedSession(projectRoot)) {
      log.info(
        `Found existing session at ${chalk.cyan(projectRoot)} — resuming.`,
      );
      await resumeSession(projectRoot);
      return;
    }
  } else if (isEmptyOrTrivial(cwd)) {
    projectName = path.basename(cwd);
    projectRoot = cwd;
    log.info(`Using current directory as project: ${chalk.cyan(projectName)}`);
  } else if (looksLikeBnaProject(cwd)) {
    // Existing BNA-ish project but no session file — offer to start a fresh session
    // without scaffolding over the code.
    log.warn(
      `This directory looks like an existing project but has no saved session.`,
    );
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          {
            name: 'Start a fresh conversational session here (keep existing files)',
            value: 'fresh-session',
          },
          {
            name: 'Create a new project in a subdirectory',
            value: 'subdir',
          },
          { name: 'Cancel', value: 'cancel' },
        ],
      },
    ]);
    if (action === 'cancel') return;
    if (action === 'fresh-session') {
      await startFreshSessionInExistingProject(cwd);
      return;
    }
    // Fall through to subdirectory prompt
    const answer = await inquirer.prompt([
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
    projectName = answer.projectName;
    projectRoot = path.resolve(cwd, projectName);
  } else {
    const answer = await inquirer.prompt([
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
    projectName = answer.projectName;
    projectRoot = path.resolve(cwd, projectName);
  }

  // ── Stack + prompt collection ───────────────────────────────────────────

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

  // ── Copy template ───────────────────────────────────────────────────────
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
  // Phase 2: Parallel install + first agent turn (via REPL)
  // ════════════════════════════════════════════════════════════════════════

  const installManager = new InstallManager(projectRoot);
  const skipInstall = options.install === false;

  if (skipInstall) {
    log.warn(
      '--no-install: skipping background npm install. ' +
        'Any `npx expo install` from the agent will fail.',
    );
  } else {
    installManager.startBaseInstall();
  }

  // Surface occasional install progress during the first turn
  let lastInstallLineAt = 0;
  const unsubscribeInstall = installManager.onBaseInstallLine((line) => {
    const now = Date.now();
    if (now - lastInstallLineAt < 3000) return;
    lastInstallLineAt = now;
    const msg = chalk.dim('  [npm install] ') + chalk.dim(line);
    process.stdout.write('\r\x1b[K' + msg + '\n');
  });

  const freshToken = await revalidateAuth();

  log.divider();
  log.info(chalk.bold('Starting build session'));
  if (!skipInstall) {
    log.info(chalk.dim('  • npm install — running in background'));
  }
  log.info(chalk.dim('  • AI agent    — starting now'));
  log.info(
    chalk.dim(
      '  • After the initial build, you can keep chatting to refine the app.',
    ),
  );
  log.divider();

  // Create the session
  const session = new Session({
    projectRoot,
    stack,
    initialPrompt: prompt,
    authToken: freshToken,
    installManager,
  });

  // Track whether the first turn has happened — after it completes, we
  // offer to run the finalization pipeline.
  let firstTurnCompleted = false;
  const unsubscribeFirstTurn = session.onOperation(() => {
    firstTurnCompleted = true;
  });

  // ── Hand control to the REPL ────────────────────────────────────────────
  //
  // The REPL runs the first turn with `initialPrompt`, then drops into
  // interactive mode. The user can chat, ask follow-ups, run /undo, etc.
  //
  // Between the first turn and the interactive phase, we intercept to
  // offer finalization (if the user wants the Convex/git/expo pipeline).

  try {
    await runRepl(session, {
      initialPrompt: prompt,
      afterFirstTurn: async () => {
        unsubscribeFirstTurn();
        if (!firstTurnCompleted) return; // nothing was built, skip
        if (options.noFinalize) return;

        // Ensure the background install is done before we kick off finalization
        if (!skipInstall) {
          await waitForInstall(installManager);
        }

        const { runFinalize } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'runFinalize',
            message:
              'Initial build looks complete. Run finalization now (Convex init, TypeScript check, git, launch simulator)?',
            default: true,
          },
        ]);

        if (runFinalize) {
          await runFinalization({
            session,
            stack,
            installManager,
            authToken: freshToken,
            skipRun: options.run === false,
          });
        } else {
          log.info(
            chalk.dim(
              'Skipped. You can run it later by typing /finalize in the session.',
            ),
          );
        }
      },
    });
  } catch (err: any) {
    unsubscribeInstall();
    installManager.abort();
    stopActiveSpinner();
    log.error(`Session failed: ${err.message ?? 'unknown error'}`);
    log.warn('Your project is preserved at ' + chalk.cyan(projectRoot));
    process.exit(1);
  }

  unsubscribeInstall();
}

// ─── Resume an existing session ─────────────────────────────────────────────

async function resumeSession(projectRoot: string): Promise<void> {
  const snapshot = Session.tryLoad(projectRoot);
  if (!snapshot) {
    log.error(`Could not load session at ${chalk.cyan(projectRoot)}.`);
    return;
  }

  log.info(
    `Resuming session from ${chalk.dim(new Date(snapshot.createdAt).toLocaleString())} ` +
      chalk.dim(`(${snapshot.turns} turn${snapshot.turns === 1 ? '' : 's'})`),
  );

  // node_modules might be stale, but we don't re-install — the agent will
  // handle new packages via npx expo install on demand. Warn if missing.
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
    log.warn(
      `No ${chalk.cyan('node_modules/')} found. Run ${chalk.cyan('npm install')} ` +
        `in this directory before launching the dev server.`,
    );
  }

  const freshToken = await revalidateAuth();
  const installManager = new InstallManager(projectRoot);

  const session = new Session({
    projectRoot,
    stack: snapshot.stack,
    initialPrompt: snapshot.initialPrompt,
    authToken: freshToken,
    installManager,
  });
  session.restoreFrom(snapshot);

  await runRepl(session); // no initialPrompt — user drives
}

// ─── Start a fresh session in an existing (non-BNA-scaffolded) project ─────

async function startFreshSessionInExistingProject(
  projectRoot: string,
): Promise<void> {
  const promptAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'prompt',
      message: chalk.yellow('What would you like to do in this project?'),
      validate: (input: string) =>
        input.trim().length > 0 || 'Please describe what you want',
    },
  ]);

  // Detect stack from package.json (best-effort)
  let stack: 'expo' | 'expo-convex' = 'expo';
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'),
    );
    if (pkg.dependencies?.convex || pkg.devDependencies?.convex) {
      stack = 'expo-convex';
    }
  } catch {
    /* ignore */
  }

  const freshToken = await revalidateAuth();
  const installManager = new InstallManager(projectRoot);

  const session = new Session({
    projectRoot,
    stack,
    initialPrompt: promptAnswer.prompt,
    authToken: freshToken,
    installManager,
  });

  await runRepl(session, { initialPrompt: promptAnswer.prompt });
}

// ─── Wait for background install (with visible spinner) ─────────────────────

async function waitForInstall(installManager: InstallManager): Promise<void> {
  const status = installManager.getStatus();
  if (status === 'ready') return;
  if (status === 'failed') {
    log.warn('Background npm install failed — continuing without it.');
    return;
  }

  const spinner = startSpinner(
    chalk.cyan('Ensuring background dependencies have finished installing'),
  );
  const result = await installManager.awaitBaseInstall();
  if (result.ok) {
    const seconds = Math.round(result.durationMs / 1000);
    spinner.succeed(chalk.green(`Dependencies installed (${seconds}s)`));
  } else {
    spinner.fail(chalk.red('npm install failed'));
  }
}

// ─── Finalization pipeline (unchanged logic, lifted into a function) ───────

interface FinalizeOptions {
  session: Session;
  stack: 'expo' | 'expo-convex';
  installManager: InstallManager;
  authToken: string;
  skipRun: boolean;
}

export async function runFinalization(opts: FinalizeOptions): Promise<void> {
  const { session, stack, installManager, authToken, skipRun } = opts;
  const projectRoot = session.projectRoot;

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
          message: 'Continue with the rest of finalization anyway?',
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
    authToken,
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
            if (result.ok) {
              log.success(`Set ${name}`);
              session.markEnvVarConfirmed(name);
            } else log.warn(`Failed to set ${name} — set it manually later`);
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

  // ── Step 5: Launch the app in the simulator ────────────────────────────
  const expoCommand = isMacOS() ? 'npx expo run:ios' : 'npx expo run:android';
  const platform = isMacOS() ? 'iOS' : 'Android';

  console.log();
  log.info(chalk.bold.cyan(`Step 5/5 — Launch app in ${platform} simulator`));
  console.log();

  if (skipRun) {
    log.info(chalk.dim('--no-run: skipping dev server launch.'));
    printReadyFooter(projectRoot, stack, expoCommand, platform);
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

  printReadyFooter(projectRoot, stack, expoCommand, platform);
}

function printReadyFooter(
  projectRoot: string,
  stack: 'expo' | 'expo-convex',
  expoCommand: string,
  platform: string,
): void {
  const cwd = process.cwd();
  const projectName = path.basename(projectRoot);
  console.log();
  log.divider();
  log.success(chalk.bold('Your app is ready!'));
  console.log();
  if (projectRoot !== cwd) log.info(`  cd ${projectName}`);
  if (stack === 'expo-convex') {
    log.info('  npx convex dev          ' + chalk.dim('# Convex backend'));
  }
  log.info(`  ${expoCommand}    ` + chalk.dim(`# ${platform} dev build`));
  console.log();
  log.info(
    chalk.dim('You are still in the conversational session — ') +
      chalk.cyan('type anything') +
      chalk.dim(' to continue building, or ') +
      chalk.cyan('/exit') +
      chalk.dim(' to quit.'),
  );
  console.log();
}
