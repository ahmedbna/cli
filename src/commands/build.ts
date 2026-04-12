// src/commands/build.ts

import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync, spawn, spawnSync } from 'child_process';
import { log } from '../utils/logger.js';
import { ensureValidAuth } from '../utils/auth.js';
import { checkCredits, deductCredits } from '../utils/credits.js';
import { getAuthToken } from '../utils/store.js';
import { runAgent } from '../agent/agent.js';

interface GenerateOptions {
  prompt?: string;
  name?: string;
  stack?: string;
  install?: boolean;
  run?: boolean;
}

/**
 * Recursively copy a directory, skipping node_modules, .git, _generated
 */
function copyTemplateDir(src: string, dest: string): void {
  const SKIP = new Set([
    'node_modules',
    '.git',
    '.expo',
    '_generated',
    'ios',
    'android',
  ]);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyTemplateDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Resolve the template directory. Works both in development and when installed as a package.
 * Looks for: <package-root>/templates/<stack>/
 */
function resolveTemplateDir(stack: string): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'templates', stack);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  const cwdCandidate = path.join(process.cwd(), 'templates', stack);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;

  throw new Error(
    `Template directory not found for stack "${stack}". ` +
      `Expected at <package>/templates/${stack}/`,
  );
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

export async function generateCommand(options: GenerateOptions): Promise<void> {
  log.banner();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Validate authentication FIRST (before ANY expensive operations)
  // This calls the BNA server to verify the token is still valid.
  // If expired, we fail fast HERE instead of after 5+ minutes of setup.
  // ═══════════════════════════════════════════════════════════════════════════
  const authResult = await ensureValidAuth();

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Check credits (also validates token server-side as a side effect)
  // ═══════════════════════════════════════════════════════════════════════════
  log.info('Checking credits...');
  const { credits, hasEnough } = await checkCredits();

  if (!hasEnough) {
    log.error(
      `Insufficient credits (${credits} remaining).\n` +
        `  Visit ${chalk.cyan('https://ai.ahmedbna.com/credits')} to purchase more credits.`,
    );
    return;
  }

  if (credits >= 0) {
    log.credits(credits);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Gather project info (interactive prompts — no network needed)
  // ═══════════════════════════════════════════════════════════════════════════

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
  if (options.stack === 'expo') {
    stack = 'expo';
  } else if (options.stack === 'expo-convex') {
    stack = 'expo-convex';
  } else {
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
  if (options.prompt) {
    prompt = options.prompt;
  } else {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Scaffold project (now safe to do expensive operations)
  // ═══════════════════════════════════════════════════════════════════════════

  log.info('Scaffolding project from template...');
  try {
    const templateDir = resolveTemplateDir(stack);

    if (!fs.existsSync(projectRoot)) {
      fs.mkdirSync(projectRoot, { recursive: true });
    }

    copyTemplateDir(templateDir, projectRoot);
    log.success(`Template copied to ${chalk.cyan(projectRoot)}`);
  } catch (err: any) {
    log.error(`Failed to copy template: ${err.message}`);
    process.exit(1);
  }

  log.info('Installing dependencies...');
  try {
    execSync('npm install', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    log.success('Dependencies installed.');
  } catch {
    log.error('npm install failed. Trying with --legacy-peer-deps...');
    try {
      execSync('npm install --legacy-peer-deps', {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '1' },
      });
      log.success('Dependencies installed (with --legacy-peer-deps).');
    } catch {
      log.error(
        'Failed to install dependencies. You may need to install them manually.',
      );
      process.exit(1);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Initialize Convex (if expo-convex)
  // ═══════════════════════════════════════════════════════════════════════════

  if (stack === 'expo-convex') {
    console.log();
    log.divider();
    log.info(chalk.bold('Step 1/2 — Setting up Convex backend'));
    log.info(
      chalk.dim(
        'Select your team, enter a project name, and choose deployment type.',
      ),
    );
    console.log();

    const convexInitOk = runInteractive('npx convex dev --once', projectRoot);

    if (!convexInitOk) {
      log.warn(
        'Convex initialization did not complete successfully.\n' +
          `  You can retry with ${chalk.cyan('npx convex dev --once')} in the project directory.`,
      );

      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Continue with the build anyway?',
          default: false,
        },
      ]);

      if (!continueAnyway) {
        log.info(
          'Exiting. Fix the issue, then run `bna build` again in the project directory.',
        );
        return;
      }
    } else {
      log.success('Convex backend initialized and deployed.');
    }

    console.log();
    log.divider();
    log.info(chalk.bold('Step 2/2 — Setting up Convex Auth'));
    log.info(
      chalk.dim(
        'This configures JWT keys and validates your auth setup. Follow the prompts.',
      ),
    );
    console.log();

    const authInitOk = runInteractive('npx @convex-dev/auth', projectRoot);

    if (!authInitOk) {
      log.warn(
        'Convex Auth setup did not complete successfully.\n' +
          `  You can run ${chalk.cyan('npx @convex-dev/auth')} manually later.`,
      );
    } else {
      log.success('Convex Auth configured.');
    }

    console.log();
    log.info('Deploying backend with auth configuration...');
    const redeployOk = runInteractive('npx convex dev --once', projectRoot);
    if (redeployOk) {
      log.success('Backend deployed with auth.');
    } else {
      log.warn(
        'Redeploy after auth setup failed — the AI agent can still proceed.',
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Re-validate auth before starting the agent
  // npm install + convex setup can take 5+ minutes — token may have expired
  // ═══════════════════════════════════════════════════════════════════════════

  log.info('Re-verifying authentication before AI agent...');
  try {
    const token = getAuthToken();

    const resp = await fetch('https://ai.ahmedbna.com/api/cli-credits', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status === 401) {
      log.error(
        'Your authentication expired during setup.\n' +
          `  Run ${chalk.cyan('bna login')} to re-authenticate, then run ${chalk.cyan('bna build')} again.\n` +
          '  Your project scaffolding is preserved — no work was lost.',
      );
      process.exit(1);
    }

    log.success('Authentication verified.');
  } catch {
    log.warn('Could not re-verify auth — proceeding anyway.');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 7: Run the AI agent
  // ═══════════════════════════════════════════════════════════════════════════

  console.log();
  log.divider();
  log.info(chalk.bold('Starting AI Agent...'));
  log.info(
    chalk.dim('The agent will customize your app based on the description.'),
  );
  log.info(chalk.dim('Every file action will be displayed in this terminal.'));
  console.log();

  const chatInitialId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await runAgent({
    projectRoot,
    prompt,
    stack,
    onCreditsUsed: async (input, output) => {
      await deductCredits(input, output, chatInitialId);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 8: Post-agent deployment + dev server start
  // ═══════════════════════════════════════════════════════════════════════════

  if (stack === 'expo-convex') {
    console.log();
    log.divider();
    log.info('Deploying AI-generated changes to Convex...');

    const finalDeployOk = runInteractive('npx convex dev --once', projectRoot);
    if (finalDeployOk) {
      log.success('Backend deployed with AI-generated changes.');
    } else {
      log.warn(
        'Deploy failed. You may need to fix schema errors and run ' +
          chalk.cyan('npx convex dev') +
          ' manually.',
      );
    }
  }

  if (stack === 'expo-convex') {
    console.log();
    log.info('Starting Convex dev server (background)...');
    const convexProc = spawn('npx', ['convex', 'dev'], {
      cwd: projectRoot,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: true,
    });
    convexProc.unref();
    log.success('Convex dev server running in background.');
  }

  console.log();
  const expoCommand = isMacOS() ? 'npx expo run:ios' : 'npx expo run:android';
  const platform = isMacOS() ? 'iOS' : 'Android';

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
    if (code !== 0) {
      log.warn(`Expo exited with code ${code}.`);
    }
  });

  console.log();
  log.divider();
  log.success(chalk.bold('Your app is ready!'));
  console.log();

  if (projectRoot !== cwd) {
    log.info(`  cd ${projectName}`);
  }

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
