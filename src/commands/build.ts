// src/commands/build.ts

import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync, spawn } from 'child_process';
import { log } from '../utils/logger.js';
import { store, isAuthenticated } from '../utils/store.js';
import { checkCredits, deductCredits } from '../utils/credits.js';
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
  // Walk up from dist/index.js or src/commands/build.ts to find the package root
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'templates', stack);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }

  // Fallback: try relative to cwd (development)
  const cwdCandidate = path.join(process.cwd(), 'templates', stack);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;

  throw new Error(
    `Template directory not found for stack "${stack}". ` +
      `Expected at <package>/templates/${stack}/`,
  );
}

/**
 * Detect if the current machine is macOS
 */
function isMacOS(): boolean {
  return os.platform() === 'darwin';
}

export async function generateCommand(options: GenerateOptions): Promise<void> {
  log.banner();

  // ── 1. Check authentication ──────────────────────────────────────────────
  const loggedIn = isAuthenticated();

  if (!loggedIn) {
    log.warn(
      'You are not logged in.\n' +
        '  Run ' +
        chalk.cyan('bna login') +
        ' to authenticate with BNA.',
    );
    return;
  }

  // ── 2. Check credits ─────────────────────────────────────────────────────
  log.info('Checking credits...');
  const { credits, hasEnough, userId } = await checkCredits();

  if (!hasEnough) {
    log.error(
      `Insufficient credits (${credits} remaining).\n` +
        `  Visit ${chalk.cyan('https://ai.ahmedbna.com/credits')} to purchase more credits.`,
    );
    return;
  }

  if (!userId) {
    log.error(
      'Could not verify your identity. Your auth token may be expired.\n' +
        `  Run ${chalk.cyan('bna login')} to re-authenticate.`,
    );
    return;
  }

  if (credits >= 0) {
    log.credits(credits);
  }

  // ── 3. Determine project directory ────────────────────────────────────────
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

  // ── 4. Choose stack ───────────────────────────────────────────────────────
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

  // ── 5. Get the prompt ─────────────────────────────────────────────────────
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

  // ── 6. Summary ────────────────────────────────────────────────────────────
  console.log();
  log.info(`Project: ${chalk.cyan(projectName)}`);
  log.info(`Stack:   ${chalk.cyan(stack)}`);
  log.info(
    `Prompt:  ${chalk.cyan(prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt)}`,
  );
  log.info(`Path:    ${chalk.dim(projectRoot)}`);
  console.log();

  // ── 7. Copy template ─────────────────────────────────────────────────────
  log.info('Scaffolding project from template...');
  try {
    const templateDir = resolveTemplateDir(stack);
    copyTemplateDir(templateDir, projectRoot);
    log.success(`Template copied to ${chalk.cyan(projectRoot)}`);
  } catch (err: any) {
    log.error(`Failed to copy template: ${err.message}`);
    process.exit(1);
  }

  // ── 8. Install dependencies ───────────────────────────────────────────────
  log.info('Installing dependencies...');
  try {
    execSync('npm install', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    });
    log.success('Dependencies installed.');
  } catch (err: any) {
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
    }
  }

  // ── 9. Initialize Convex auth (if expo-convex) ────────────────────────────
  if (stack === 'expo-convex') {
    log.info('Initializing Convex auth...');
    try {
      execSync('npx @convex-dev/auth', {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '1' },
      });
      log.success('Convex auth initialized.');
    } catch {
      log.warn(
        'Convex auth initialization failed. You may need to run `npx @convex-dev/auth` manually.',
      );
    }
  }

  // ── 10. Run the AI agent ──────────────────────────────────────────────────
  const chatInitialId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await runAgent({
    projectRoot,
    prompt,
    stack,
    onCreditsUsed: async (input, output) => {
      await deductCredits(input, output, chatInitialId);
    },
  });

  // ── 11. Post-agent: deploy Convex and start dev servers ───────────────────
  if (stack === 'expo-convex') {
    log.divider();
    log.info('Starting Convex backend...');

    // Push schema + functions once
    try {
      execSync('npx convex dev --once', {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '1' },
      });
      log.success('Convex backend deployed.');
    } catch {
      log.warn(
        'Convex initial deploy failed. You may need to run `npx convex dev` manually.',
      );
    }

    // Start `npx convex dev` in the background
    log.info('Starting Convex dev server (background)...');
    const convexProc = spawn('npx', ['convex', 'dev'], {
      cwd: projectRoot,
      stdio: 'inherit',
      detached: true,
      env: { ...process.env, FORCE_COLOR: '1' },
      shell: true,
    });
    convexProc.unref();
    log.success('Convex dev server running in background.');
  }

  // Start Expo
  log.info('Starting Expo dev build...');
  const expoCommand = isMacOS() ? 'npx expo run:ios' : 'npx expo run:android';
  const platform = isMacOS() ? 'iOS' : 'Android';

  log.info(
    `Detected ${chalk.cyan(platform)} — running ${chalk.cyan(expoCommand)}`,
  );

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

  // ── 12. Final instructions ────────────────────────────────────────────────
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
