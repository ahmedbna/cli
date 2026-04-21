// src/utils/logger.ts
//
// Pretty terminal output, with transparent UI routing.
//
// When Ink is mounted (isUiActive() === true), log.info/warn/error/success
// emit 'info'/'warn'/'error'/'success' events onto the UI bus so they
// render as inline system lines inside the Ink tree — no stdout writes
// that would corrupt the live region.
//
// When not mounted, they behave exactly as before: chalk-colored
// console.log lines. The visual language is identical in both modes.

import chalk from 'chalk';
import figures from 'figures';
import { emit, isUiActive } from '../ui/events.js';

// ASCII Art for BNA
const bnaBanner = `
${chalk.yellow('██████╗ ███╗   ██╗███████╗ ')}
${chalk.yellow('██╔══██╗████╗  ██║██╔══██║')}
${chalk.yellow('██████╔╝██╔██╗ ██║███████║')}
${chalk.yellow('██╔══██╗██║╚██╗██║██╔══██║')}
${chalk.yellow('██████╔╝██║ ╚████║██║  ██║')}
${chalk.yellow('╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝')}

${chalk.gray('Build fullstack applications with AI in minutes from your terminal.')}
`;

// Strip chalk codes when routing through the UI bus — Ink handles color
// its own way and embedded ANSI codes would render as literal garbage.
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export const log = {
  info: (msg: string) => {
    if (isUiActive()) emit({ type: 'info', text: strip(msg) });
    else console.log(chalk.cyan(figures.info) + ' ' + msg);
  },

  success: (msg: string) => {
    if (isUiActive()) emit({ type: 'success', text: strip(msg) });
    else console.log(chalk.green(figures.tick) + ' ' + msg);
  },

  warn: (msg: string) => {
    if (isUiActive()) emit({ type: 'warn', text: strip(msg) });
    else console.log(chalk.yellow(figures.warning) + ' ' + msg);
  },

  error: (msg: string) => {
    if (isUiActive()) emit({ type: 'error', text: strip(msg) });
    else console.error(chalk.red(figures.cross) + ' ' + msg);
  },

  step: (n: number, msg: string) => {
    if (isUiActive()) emit({ type: 'info', text: `[${n}] ${strip(msg)}` });
    else console.log(chalk.dim(`[${n}]`) + ' ' + chalk.bold(msg));
  },

  file: (action: 'create' | 'update', path: string) => {
    if (isUiActive()) {
      emit({
        type: 'info',
        text: `${action === 'create' ? '+' : '~'} ${path}`,
      });
      return;
    }
    const icon = action === 'create' ? chalk.green('+') : chalk.yellow('~');
    console.log(`  ${icon} ${chalk.dim(path)}`);
  },

  command: (cmd: string) => {
    if (isUiActive()) emit({ type: 'info', text: `$ ${cmd}` });
    else console.log(chalk.dim('  $ ') + chalk.white(cmd));
  },

  divider: () => {
    if (isUiActive()) emit({ type: 'divider' });
    else console.log(chalk.dim('─'.repeat(60)));
  },

  banner: () => {
    // The banner is only printed once, before the Ink app mounts, so
    // UI-active mode never hits this path. Preserve the existing behavior.
    console.log(bnaBanner);
  },

  credits: (remaining: number) => {
    if (isUiActive()) {
      emit({ type: 'info', text: `Credits: ${remaining} remaining` });
      return;
    }
    const color =
      remaining > 20 ? chalk.green : remaining > 5 ? chalk.yellow : chalk.red;
    console.log(
      chalk.dim('Credits: ') +
        color.bold(String(remaining)) +
        chalk.dim(' remaining'),
    );
  },

  stream: (text: string) => {
    // Never routed through the UI — raw streaming is only used by legacy paths
    if (!isUiActive()) process.stdout.write(text);
  },
};
