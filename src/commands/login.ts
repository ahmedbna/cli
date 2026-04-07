// src/commands/login.ts

import crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { store } from '../utils/store.js';
import { log } from '../utils/logger.js';

const API_BASE = 'https://ai.ahmedbna.com';
const LOGIN_PATH = '/cli-login';
const POLL_PATH = '/api/cli-auth';
const POLL_INTERVAL = 2000;
const POLL_TIMEOUT = 300_000; // 5 minutes

export async function loginCommand(): Promise<void> {
  log.banner();

  if (store.get('authToken')) {
    log.success('You are already logged in.');
    log.info(`Email:   ${chalk.cyan(store.get('email') ?? 'unknown')}`);
    log.info(`User ID: ${chalk.dim(store.get('userId') ?? 'unknown')}`);
    log.info(
      'Run `bna logout` to sign out, or `bna generate` to start building.',
    );
    return;
  }

  const sessionId = crypto.randomUUID();
  const loginUrl = `${API_BASE}${LOGIN_PATH}?session_id=${sessionId}`;

  log.info('Opening browser for authentication...');
  console.log();
  log.info(chalk.dim("If the browser doesn't open, visit:"));
  log.info(chalk.cyan(loginUrl));
  console.log();

  try {
    await open(loginUrl);
  } catch {
    log.warn('Could not open browser automatically.');
  }

  const spinner = ora('Waiting for authentication...').start();

  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT) {
    await sleep(POLL_INTERVAL);

    try {
      const resp = await fetch(
        `${API_BASE}${POLL_PATH}?session_id=${sessionId}`,
      );
      if (!resp.ok) continue;

      const data = await resp.json();

      if (data.token) {
        spinner.succeed('Authenticated!');

        // Store the auth token (Convex JWT)
        store.set('authToken', data.token);

        // Store identity fields from the payload
        if (data.userId) store.set('userId', data.userId);
        if (data.email) store.set('email', data.email);
        if (data.convexAccessToken)
          store.set('convexAccessToken', data.convexAccessToken);
        if (data.teamSlug) store.set('convexTeamSlug', data.teamSlug);

        // If userId wasn't in the payload, try JWT
        if (!data.userId) {
          try {
            const payload = JSON.parse(
              Buffer.from(data.token.split('.')[1], 'base64url').toString(
                'utf-8',
              ),
            );
            if (payload.sub) store.set('userId', payload.sub);
            if (payload.email && !data.email) store.set('email', payload.email);
          } catch {}
        }

        // Validate token + resolve userId server-side
        await validateAndResolveUser();

        console.log();
        log.success(`Logged in as ${chalk.cyan(store.get('email') ?? 'user')}`);
        if (store.get('userId')) {
          log.info(`User ID: ${chalk.dim(store.get('userId')!)}`);
        }
        log.info('Run `bna generate` or just `bna` to start building!');
        return;
      }
    } catch {
      // Network error — keep polling
    }
  }

  spinner.fail('Authentication timed out. Please try again with `bna login`.');
}

/**
 * Call /api/cli-credits (GET) to validate the token and resolve userId
 * from the server. This ensures we have the correct Convex userId.
 */
async function validateAndResolveUser(): Promise<void> {
  const token = store.get('authToken');
  if (!token) return;

  try {
    const apiBase = store.get('apiBaseUrl');
    const resp = await fetch(`${apiBase}/api/cli-credits`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.userId) store.set('userId', data.userId);
      if (data.email) store.set('email', data.email);
    }
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
