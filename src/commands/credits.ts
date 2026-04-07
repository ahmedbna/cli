// src/commands/credits.ts

import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { isAuthenticated } from '../utils/store.js';
import { checkCredits } from '../utils/credits.js';

export async function creditsCommand(): Promise<void> {
  if (!isAuthenticated()) {
    log.warn('Not logged in. Run `bna login` first.');
    return;
  }

  log.info('Checking credit balance...');
  const { credits, hasEnough, userId, email } = await checkCredits();

  if (credits < 0 && !userId) {
    log.error(
      'Could not verify your identity. Your auth token may be expired.\n' +
        `  Run ${chalk.cyan('bna login')} to re-authenticate.`,
    );
    return;
  }

  if (credits === -1) {
    log.warn('Could not fetch credit balance. Check your internet connection.');
    return;
  }

  console.log();
  if (email) {
    log.info(`Account: ${chalk.cyan(email)}`);
  }
  log.credits(credits);

  if (!hasEnough) {
    log.warn(
      `You're low on credits. Visit ${chalk.cyan('https://ai.ahmedbna.com/credits')} to purchase more.`,
    );
  } else {
    log.info('Each generation uses credits based on token usage.');
    log.info(
      `Or use your own API key to skip credits: ${chalk.cyan('bna config --api-key sk-ant-...')}`,
    );
  }
  console.log();
}
