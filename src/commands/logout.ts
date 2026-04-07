// src/commands/logout.ts

import { log } from '../utils/logger.js';
import { clearAuth, isAuthenticated } from '../utils/store.js';

export async function logoutCommand(): Promise<void> {
  if (!isAuthenticated()) {
    log.info('You are not logged in.');
    return;
  }

  clearAuth();
  log.success('Logged out successfully.');
}
