// src/index.ts
// BNA CLI — AI agent that builds full-stack mobile apps directly from your terminal

import { Command } from 'commander';
import chalk from 'chalk';
import { loginCommand } from './commands/login.js';
import { generateCommand } from './commands/build.js';
import { creditsCommand } from './commands/credits.js';
import { logoutCommand } from './commands/logout.js';
import { configCommand } from './commands/config.js';

const program = new Command();

program
  .name('bna')
  .description(
    chalk.yellow.bold('BNA') +
      ' — CLI AI agent that builds full-stack apps directly from your terminal',
  )
  .version('1.0.0');

// ─── bna login ──────────────────────────────────────────────────────────────
program
  .command('login')
  .description('Authenticate with your BNA account')
  .action(loginCommand);

// ─── bna logout ─────────────────────────────────────────────────────────────
program
  .command('logout')
  .description('Clear saved authentication')
  .action(logoutCommand);

// ─── bna build (default command) ─────────────────────────────────────────
program
  .command('build')
  .alias('b')
  .description('Build a full-stack mobile application')
  .option('-p, --prompt <prompt>', 'App description prompt')
  .option('-n, --name <name>', 'Project name')
  .option('-s, --stack <stack>', 'Stack: expo | expo-convex')
  .option('--no-install', 'Skip npm install after generation')
  .option('--no-run', 'Skip running the dev server after generation')
  .action(generateCommand);

// ─── bna credits ────────────────────────────────────────────────────────────
program
  .command('credits')
  .description('Check your credit balance')
  .action(creditsCommand);

// ─── bna config ─────────────────────────────────────────────────────────────
program
  .command('config')
  .description('View CLI configuration')
  .option('--show', 'Show current configuration')
  .action(configCommand);

// Default: if no command is given, run build
program.action(() => {
  generateCommand({});
});

program.parse();
