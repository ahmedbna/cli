// src/commands/generate.ts

import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
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

export async function generateCommand(options: GenerateOptions): Promise<void> {
  log.banner();

  // ── 1. Check authentication ──────────────────────────────────────────────
  const hasOwnApiKey =
    !!store.get('anthropicApiKey') || !!process.env.ANTHROPIC_API_KEY;
  const loggedIn = isAuthenticated();

  if (!loggedIn && !hasOwnApiKey) {
    log.warn(
      'You are not logged in and no API key is configured.\n' +
        '  Run ' +
        chalk.cyan('bna login') +
        ' to authenticate with BNA, or\n' +
        '  Run ' +
        chalk.cyan('bna config --api-key sk-ant-...') +
        ' to use your own Anthropic key.',
    );
    return;
  }

  // ── 2. Check credits (only when using BNA server, not own key) ───────────
  const usingBnaCredits = loggedIn && !hasOwnApiKey;

  if (usingBnaCredits) {
    log.info('Checking credits...');
    const { credits, hasEnough, userId } = await checkCredits();

    if (!hasEnough) {
      log.error(
        `Insufficient credits (${credits} remaining).\n` +
          `  Visit ${chalk.cyan('https://ai.ahmedbna.com/credits')} to purchase more credits.\n` +
          `  Or use your own API key: ${chalk.cyan('bna config --api-key sk-ant-...')}`,
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
  } else if (loggedIn && hasOwnApiKey) {
    log.info(
      chalk.dim('Using your own API key — BNA credits will not be deducted.'),
    );
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

  // Create project dir if needed
  if (!fs.existsSync(projectRoot)) {
    fs.mkdirSync(projectRoot, { recursive: true });
    log.success(`Created directory: ${chalk.cyan(projectRoot)}`);
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

  // ── 7. Run the agent ──────────────────────────────────────────────────────
  const chatInitialId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await runAgent({
    projectRoot,
    prompt,
    stack,
    onCreditsUsed: usingBnaCredits
      ? async (input, output) => {
          await deductCredits(input, output, chatInitialId);
        }
      : undefined,
  });

  // ── 8. Post-generation instructions ───────────────────────────────────────
  console.log();
  log.divider();
  log.success(chalk.bold('Your app is ready!'));
  console.log();

  if (projectRoot !== cwd) {
    log.info(`  cd ${projectName}`);
  }

  log.info('  npm install             ' + chalk.dim('# Install dependencies'));

  if (stack === 'expo-convex') {
    log.info(
      '  npx convex dev          ' +
        chalk.dim('# Start Convex backend (keep running)'),
    );
  }
  log.info('  npx expo run:ios        ' + chalk.dim('# Run on iOS simulator'));
  log.info(
    '  npx expo run:android    ' + chalk.dim('# Run on Android emulator'),
  );
  console.log();
}
