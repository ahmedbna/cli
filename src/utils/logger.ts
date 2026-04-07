// src/utils/logger.ts

import chalk from 'chalk';
import boxen from 'boxen';
import figures from 'figures';

export const log = {
  info: (msg: string) => console.log(chalk.cyan(figures.info) + ' ' + msg),
  success: (msg: string) => console.log(chalk.green(figures.tick) + ' ' + msg),
  warn: (msg: string) => console.log(chalk.yellow(figures.warning) + ' ' + msg),
  error: (msg: string) => console.error(chalk.red(figures.cross) + ' ' + msg),
  step: (n: number, msg: string) =>
    console.log(chalk.dim(`[${n}]`) + ' ' + chalk.bold(msg)),
  file: (action: 'create' | 'update', path: string) => {
    const icon = action === 'create' ? chalk.green('+') : chalk.yellow('~');
    console.log(`  ${icon} ${chalk.dim(path)}`);
  },
  command: (cmd: string) =>
    console.log(chalk.dim('  $ ') + chalk.white(cmd)),
  divider: () => console.log(chalk.dim('─'.repeat(60))),
  banner: () => {
    console.log(
      boxen(
        chalk.yellow.bold('  BNA  ') +
          chalk.dim('— AI Agent\n') +
          chalk.dim('Idea → fullstack mobile app in seconds'),
        {
          padding: 1,
          margin: { top: 1, bottom: 1, left: 0, right: 0 },
          borderColor: 'yellow',
          borderStyle: 'round',
        }
      )
    );
  },
  credits: (remaining: number) => {
    const color = remaining > 20 ? chalk.green : remaining > 5 ? chalk.yellow : chalk.red;
    console.log(
      chalk.dim('Credits: ') + color.bold(String(remaining)) + chalk.dim(' remaining')
    );
  },
  stream: (text: string) => process.stdout.write(text),
};
