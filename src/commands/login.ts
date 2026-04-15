// src/commands/login.ts
//
// Browser-based OAuth login for the BNA CLI.
//
// Flow:
//   1. Generate a random session_id
//   2. Open browser to ai.ahmedbna.com/cli-login?session_id=XXX
//   3. User signs in (Google/GitHub OAuth via Convex Auth)
//   4. Browser page stores auth token + refresh token in Convex
//   5. CLI polls Convex HTTP action at /cli/poll?session_id=XXX
//   6. On success, CLI stores both tokens locally
//
// The polling endpoint is a Convex HTTP action — no Remix API route needed.

import crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { store, setAuthData, CONVEX_SITE_URL } from '../utils/store.js';
import { log } from '../utils/logger.js';

const WEB_APP_URL = 'https://ai.ahmedbna.com';
const LOGIN_PATH = '/cli-login';
const POLL_INTERVAL = 2000;
const POLL_TIMEOUT = 300_000; // 5 minutes

export async function loginCommand(): Promise<void> {
  log.banner();

  if (store.get('authToken')) {
    // Check if the 30-day session is still valid
    const expiresAt = store.get('sessionExpiresAt');
    if (expiresAt && Date.now() < expiresAt) {
      const daysRemaining = Math.ceil(
        (expiresAt - Date.now()) / (24 * 60 * 60 * 1000),
      );
      log.success('You are already logged in.');
      log.info(`Email:   ${chalk.cyan(store.get('email') ?? 'unknown')}`);
      log.info(`User ID: ${chalk.dim(store.get('userId') ?? 'unknown')}`);
      log.info(`Session: ${chalk.green(`${daysRemaining} days remaining`)}`);
      log.info(
        'Run `bna logout` to sign out, or `bna build` to start building.',
      );
      return;
    } else {
      log.info('Your previous session has expired. Starting fresh login...');
    }
  }

  const sessionId = crypto.randomUUID();
  const loginUrl = `${WEB_APP_URL}${LOGIN_PATH}?session_id=${sessionId}`;

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

  // Determine the polling URL — use Convex site URL directly
  const pollUrl = `${CONVEX_SITE_URL}/cli/poll`;

  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT) {
    await sleep(POLL_INTERVAL);

    try {
      const resp = await fetch(
        `${pollUrl}?session_id=${encodeURIComponent(sessionId)}`,
      );

      if (!resp.ok) {
        spinner.text = `Waiting for authentication... (server: ${resp.status})`;
        continue;
      }

      let data: any;
      try {
        data = await resp.json();
      } catch {
        spinner.text = 'Waiting for authentication... (bad response)';
        continue;
      }

      // The server returns { token: null } when no token is stored yet
      if (!data || data.token === null || data.token === undefined) {
        continue;
      }

      // We have tokens!
      spinner.succeed('Authenticated!');

      // Store auth data
      setAuthData({
        token: data.token,
        refreshToken: data.refreshToken ?? '',
        userId: data.userId,
        email: data.email,
        convexSiteUrl: CONVEX_SITE_URL,
      });

      // Store additional Convex connection fields if present
      if (data.convexAccessToken) {
        store.set('convexAccessToken', data.convexAccessToken);
      }
      if (data.teamSlug) {
        store.set('convexTeamSlug', data.teamSlug);
      }

      console.log();
      log.success(`Logged in as ${chalk.cyan(store.get('email') ?? 'user')}`);
      if (store.get('userId')) {
        log.info(`User ID: ${chalk.dim(store.get('userId')!)}`);
      }
      log.info(`Session valid for ${chalk.green('30 days')}.`);
      log.info('Run `bna build` or just `bna` to start building!');
      return;
    } catch {
      // Network error — keep polling silently
      spinner.text = 'Waiting for authentication... (retrying)';
    }
  }

  spinner.fail('Authentication timed out. Please try again with `bna login`.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
