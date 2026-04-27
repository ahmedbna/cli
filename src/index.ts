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

// Build flags shared between the default action (`bna`) and `bna init`.
const buildOptions = (cmd: Command) =>
  cmd
    .option('-p, --prompt <prompt>', 'App description prompt')
    .option('-n, --name <name>', 'Project name')
    .option('-f, --frontend <frontend>', 'Frontend: expo')
    .option('-b, --backend <backend>', 'Backend: convex')
    .option(
      '--skills <skills>',
      'Anthropic Agent Skills to use (comma-separated: pptx,xlsx,docx,pdf or custom skill IDs)',
    )
    .option('--no-install', 'Skip npm install after generation')
    .option('--no-run', 'Skip running the dev server after generation');

// ─── bna (default) ──────────────────────────────────────────────────────────
// Running `bna` with no subcommand drops into the conversational REPL:
//   - If the cwd has a saved session/blueprint under `.bna/`, resume it.
//   - Otherwise, walk the user through stack selection and scaffold a new app.
buildOptions(
  program
    .name('bna')
    .description(
      chalk.yellow.bold('BNA') +
        ' — CLI AI agent that builds full-stack apps directly from your terminal',
    )
    .version('1.0.0'),
).action(generateCommand);

// ─── bna init ───────────────────────────────────────────────────────────────
// Explicit alias of the default action — handy when the bare `bna` invocation
// is shadowed by another binary or when intent should be obvious in scripts.
buildOptions(
  program
    .command('init')
    .description('Start a new project (or resume an existing session in this directory)'),
).action(generateCommand);

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

program.parse();
