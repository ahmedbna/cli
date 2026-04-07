// src/commands/config.ts

import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { store } from '../utils/store.js';

interface ConfigOptions {
  apiKey?: string;
  clearApiKey?: boolean;
  show?: boolean;
}

export async function configCommand(options: ConfigOptions): Promise<void> {
  if (options.apiKey) {
    if (!options.apiKey.startsWith('sk-ant-')) {
      log.warn('API key should start with "sk-ant-". Double-check your key.');
    }
    store.set('anthropicApiKey', options.apiKey);
    log.success('Anthropic API key saved.');
    log.info(chalk.dim('You can now run `bna generate` without logging in.'));
    return;
  }

  if (options.clearApiKey) {
    store.set('anthropicApiKey', null);
    log.success('API key removed.');
    return;
  }

  // Default: show config
  console.log();
  log.info(chalk.bold('BNA CLI Configuration'));
  log.divider();

  const token = store.get('authToken');
  const email = store.get('email');
  const apiKey = store.get('anthropicApiKey');
  const team = store.get('convexTeamSlug');

  log.info(`Authenticated:  ${token ? chalk.green('yes') : chalk.red('no')}`);
  if (email) log.info(`Email:          ${chalk.cyan(email)}`);
  if (team) log.info(`Convex team:    ${chalk.cyan(team)}`);
  log.info(
    `API key:        ${apiKey ? chalk.green('set (own key)') : chalk.dim('using BNA server')}`
  );
  log.info(`Config path:    ${chalk.dim(store.path)}`);
  console.log();
}
