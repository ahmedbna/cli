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
import {
  runInteractive,
  runStreamed,
  waitForInstall,
} from '../utils/runProcess.js';
import { typeCheckAndFix } from '../utils/tsCheck.js';
import { initGitRepo } from '../utils/gitInit.js';
import { Session } from '../session/session.js';
import { runRepl } from '../session/repl.js';
import {
  FRONTENDS,
  BACKENDS,
  combineStack,
  isFrontend,
  isBackend,
  type Frontend,
  type Backend,
  type StackId,
} from './stacks.js';

interface GenerateOptions {
  prompt?: string;
  name?: string;
  frontend?: string;
  backend?: string;
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

// ─── Session detection ──────────────────────────────────────────────────────

function hasSavedSession(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.bna', 'session.json'));
}

// Broader check: any persisted BNA state under `.bna/` (session OR blueprint).
// We treat a project with either as "already a BNA project" so `bna` drops
// straight into chat instead of trying to re-scaffold over the user's work.
function hasSavedState(projectRoot: string): boolean {
  const bnaDir = path.join(projectRoot, '.bna');
  return (
    fs.existsSync(path.join(bnaDir, 'session.json')) ||
    fs.existsSync(path.join(bnaDir, 'blueprint.json'))
  );
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

  if (!options.name && hasSavedState(cwd)) {
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
    if (fs.existsSync(projectRoot) && hasSavedState(projectRoot)) {
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

  // ── Stack selection — frontend + backend picked separately ─────────────

  let frontend: Frontend;
  if (options.frontend) {
    if (!isFrontend(options.frontend)) {
      log.error(
        `Unknown frontend "${options.frontend}". Available: ${FRONTENDS.map((f) => f.value).join(', ')}.`,
      );
      return;
    }
    frontend = options.frontend;
  } else {
    const { frontend: picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'frontend',
        message: 'Choose your frontend:',
        choices: FRONTENDS.map((f) => ({
          name: `${chalk.yellow(f.name)} ${chalk.dim('— ' + f.description)}`,
          value: f.value,
        })),
        default: FRONTENDS[0].value,
      },
    ]);
    frontend = picked;
  }

  let backend: Backend;
  if (options.backend) {
    if (!isBackend(options.backend)) {
      log.error(
        `Unknown backend "${options.backend}". Available: ${BACKENDS.map((b) => b.value).join(', ')}.`,
      );
      return;
    }
    backend = options.backend;
  } else {
    const { backend: picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'backend',
        message: 'Choose your backend:',
        choices: BACKENDS.map((b) => ({
          name: `${chalk.yellow(b.name)} ${chalk.dim('— ' + b.description)}`,
          value: b.value,
        })),
        default: BACKENDS[0].value,
      },
    ]);
    backend = picked;
  }

  let stack: StackId;
  try {
    stack = combineStack(frontend, backend);
  } catch (err: any) {
    log.error(err.message);
    return;
  }

  // If --prompt was passed on the CLI, use it; otherwise leave it undefined
  // and let the REPL ask inline as the first chat turn.
  const prompt = options.prompt?.trim() || undefined;

  // let prompt: string;
  // if (options.prompt) prompt = options.prompt;
  // else {
  //   const promptAnswer = await inquirer.prompt([
  //     {
  //       type: 'input',
  //       name: 'prompt',
  //       message: chalk.yellow('What do you want to build?'),
  //       validate: (input: string) =>
  //         input.trim().length > 0 || 'Please describe your app',
  //     },
  //   ]);
  //   prompt = promptAnswer.prompt;
  // }

  console.log();
  log.info(`Project:  ${chalk.cyan(projectName)}`);
  log.info(`Frontend: ${chalk.cyan(frontend)}`);
  log.info(`Backend:  ${chalk.cyan(backend)}`);
  // log.info(
  //   `Prompt:   ${chalk.cyan(prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt)}`,
  // );
  log.info(`Path:     ${chalk.dim(projectRoot)}`);
  console.log();

  // ── Copy template ───────────────────────────────────────────────────────
  {
    // const initSpinner = startSpinner(chalk.cyan('Initializing the app'));
    try {
      const templateDir = resolveTemplateDir(stack);
      if (!fs.existsSync(projectRoot)) {
        fs.mkdirSync(projectRoot, { recursive: true });
      }
      copyTemplateDir(templateDir, projectRoot);
      // initSpinner.succeed(
      //   chalk.green(`App initialized at ${chalk.cyan(projectRoot)}`),
      // );
    } catch (err: any) {
      // initSpinner.fail(chalk.red('Failed to initialize the app'));
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

  log.success(chalk.bold('Starting build...'));
  if (!skipInstall) {
    log.info(chalk.dim('  npm install — running in background'));
  }
  log.info(chalk.dim('  AI agent    — starting now'));
  log.info(
    chalk.dim(
      '  After the initial build, you can keep chatting to refine the app.',
    ),
  );
  log.info(chalk.dim('  esc to interrupt ·  ctrl+c to exit'));

  // Create the session
  const session = new Session({
    projectRoot,
    stack,
    initialPrompt: prompt ?? '',
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
    // No session file but `.bna/blueprint.json` exists (interrupted build, or
    // user kept the blueprint and discarded the session). Drop into a fresh
    // chat session over the existing project rather than refusing.
    if (fs.existsSync(path.join(projectRoot, '.bna', 'blueprint.json'))) {
      log.info(
        `Found existing blueprint at ${chalk.cyan(projectRoot)} — starting a fresh chat session.`,
      );
      await startFreshSessionInExistingProject(projectRoot);
      return;
    }
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
  let stack: StackId = 'expo';
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'),
    );
    if (pkg.dependencies?.convex || pkg.devDependencies?.convex) {
      stack = 'expo-convex';
    } else if (
      pkg.dependencies?.['@supabase/supabase-js'] ||
      pkg.devDependencies?.['@supabase/supabase-js']
    ) {
      stack = 'expo-supabase';
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

// ─── Finalization pipeline (unchanged logic, lifted into a function) ───────

interface FinalizeOptions {
  session: Session;
  stack: StackId;
  installManager: InstallManager;
  authToken: string;
  skipRun: boolean;
}

export async function runFinalization(opts: FinalizeOptions): Promise<void> {
  const { session, stack, installManager, authToken, skipRun } = opts;
  const projectRoot = session.projectRoot;

  // The orchestrator's between-phases backend setup may have already run
  // Convex init / auth / env-var collection / `npx convex dev` (background).
  // When that ran successfully, we skip those steps here to avoid asking
  // the user the same questions twice.
  const skipBackendSetup = session.isBackendDeployed();

  console.log();
  log.divider();
  log.info(chalk.bold('Finalizing your app'));
  log.divider();

  // ── Step 1: Convex init ────────────────────────────────────────────────
  if (skipBackendSetup) {
    log.info(
      chalk.dim(
        'Step 1/5 — Backend already deployed during build (skipping init).',
      ),
    );
  } else if (stack === 'expo-convex') {
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
  } else if (stack === 'expo-supabase') {
    log.info(
      chalk.dim(
        'Step 1/5 — Convex init skipped (Supabase stack). Remember to run ' +
          chalk.cyan('npx supabase start') +
          chalk.dim(' and copy the printed keys into .env.local.'),
      ),
    );
  } else {
    log.info(chalk.dim('Step 1/5 — Backend init skipped (Expo-only stack).'));
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
  if (skipBackendSetup) {
    log.info(
      chalk.dim(
        'Step 4/5 — Auth + env vars already configured during build.',
      ),
    );
  } else if (stack === 'expo-convex') {
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
      if (stack === 'expo-supabase') {
        log.info(
          chalk.dim(
            '  Add these to .env.local alongside your EXPO_PUBLIC_SUPABASE_URL and anon key.',
          ),
        );
      } else {
        log.info(
          chalk.dim(
            '  Add these to your Expo app via app.json `extra` or a .env file as appropriate.',
          ),
        );
      }
      clearPendingEnvVars();
    }
    if (stack === 'expo-supabase') {
      log.info(
        chalk.dim(
          'Step 4/5 — Convex Auth skipped (Supabase stack uses SQL migrations + RLS).',
        ),
      );
    } else {
      log.info(chalk.dim('Step 4/5 — Auth setup skipped (Expo-only stack).'));
    }
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

  if (stack === 'expo-convex' && !skipBackendSetup) {
    // When the orchestrator already ran the backend setup, `npx convex dev`
    // is already running in the background — don't start a second one.
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
  stack: StackId,
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
  } else if (stack === 'expo-supabase') {
    log.info('  npx supabase start      ' + chalk.dim('# Local Supabase stack'));
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
