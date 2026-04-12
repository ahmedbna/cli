// src/commands/login.ts

import crypto from 'crypto';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { store, setAuthData } from '../utils/store.js';
import { log } from '../utils/logger.js';

const API_BASE = 'https://ai.ahmedbna.com';
const LOGIN_PATH = '/cli-login';
const POLL_PATH = '/api/cli-auth';
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
      // Session expired — clear and re-login
      log.info('Your previous session has expired. Starting fresh login...');
    }
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
      const pollUrl = `${API_BASE}${POLL_PATH}?session_id=${encodeURIComponent(sessionId)}`;
      const resp = await fetch(pollUrl);

      if (!resp.ok) {
        if (resp.status !== 200) {
          spinner.text = `Waiting for authentication... (server: ${resp.status})`;
        }
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

      // We have a token!
      spinner.succeed('Authenticated!');

      // Use setAuthData to store everything with 30-day session expiry
      const authData: Parameters<typeof setAuthData>[0] = {
        token: data.token,
      };

      if (data.userId) authData.userId = data.userId;
      if (data.email) authData.email = data.email;
      if (data.convexAccessToken)
        authData.convexAccessToken = data.convexAccessToken;
      if (data.teamSlug) authData.teamSlug = data.teamSlug;

      setAuthData(authData);

      // Store additional fields directly
      if (data.convexAccessToken) {
        store.set('convexAccessToken', data.convexAccessToken);
      }
      if (data.teamSlug) {
        store.set('convexTeamSlug', data.teamSlug);
      }

      // If userId wasn't in the payload, try decoding the JWT
      if (!data.userId && data.token) {
        try {
          const parts = data.token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(
              Buffer.from(parts[1], 'base64url').toString('utf-8'),
            );
            if (payload.sub) store.set('userId', payload.sub);
            if (payload.email && !data.email) store.set('email', payload.email);
          }
        } catch {
          // JWT decode failed — not critical
        }
      }

      // Validate token + resolve userId server-side
      await validateAndResolveUser();

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

/**
 * Call /api/cli-credits (GET) to validate the token and resolve userId
 * from the server. This ensures we have the correct Convex userId.
 */
async function validateAndResolveUser(): Promise<void> {
  const token = store.get('authToken');
  if (!token) return;

  try {
    const resp = await fetch(`${API_BASE}/api/cli-credits`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.userId) store.set('userId', data.userId);
      if (data.email) store.set('email', data.email);
    }
  } catch {
    // Non-critical — we already have the token
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
