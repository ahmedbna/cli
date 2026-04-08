// src/commands/config.ts

import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { store } from '../utils/store.js';

export async function configCommand(): Promise<void> {
  // Default: show config
  console.log();
  log.info(chalk.bold('BNA CLI Configuration'));
  log.divider();

  const token = store.get('authToken');
  const email = store.get('email');
  const team = store.get('convexTeamSlug');

  log.info(`Authenticated:  ${token ? chalk.green('yes') : chalk.red('no')}`);
  if (email) log.info(`Email:          ${chalk.cyan(email)}`);
  if (team) log.info(`Convex team:    ${chalk.cyan(team)}`);
  log.info(`Config path:    ${chalk.dim(store.path)}`);
  console.log();
}
