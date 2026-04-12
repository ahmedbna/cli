// src/utils/auth.ts
// Token validation and refresh utilities.
//
// The Convex JWT stored at login typically expires in a short window (minutes to hours).
// The CLI session itself lasts 30 days (tracked locally in store.sessionExpiresAt).
//
// Before any API call, call `ensureValidToken()` which:
//   1. Checks if the local 30-day session is still valid
//   2. Checks if the JWT is expired (by decoding the exp claim)
//   3. If expired, calls /api/cli-credits to validate server-side
//      (the server validates the token and returns userId/email)
//   4. If server says 401, the user must re-login
//
// The key insight: the /api/cli-chat endpoint on the server uses the token
// to authenticate via `client.setAuth(token)` → `api.users.getCurrentUserId`.
// If the Convex JWT is expired, this fails with 401.
//
// Solution: We call /api/cli-credits (GET) as a lightweight validation check
// before starting the heavy build pipeline. If it returns 401, we fail fast.

import { store, getAuthToken, isTokenExpired, clearAuth } from './store.js';
import { log } from './logger.js';
import chalk from 'chalk';

const API_BASE = 'https://ai.ahmedbna.com';

export interface AuthValidation {
  valid: boolean;
  userId: string | null;
  email: string | null;
  token: string;
  error?: string;
}

/**
 * Validate the stored auth token against the BNA server.
 * Returns the validation result. If invalid, provides an error message.
 *
 * This should be called BEFORE any expensive operations (npm install, convex setup, etc.)
 */
export async function validateAuthToken(): Promise<AuthValidation> {
  let token: string;
  try {
    token = getAuthToken(); // Throws if no token or 30-day session expired
  } catch (err: any) {
    return {
      valid: false,
      userId: null,
      email: null,
      token: '',
      error: err.message,
    };
  }

  // Quick local check: is the JWT exp claim expired?
  const jwtExpired = isTokenExpired();

  if (jwtExpired) {
    // Try to refresh by calling the server — the server might still accept
    // the token if it's within a grace period, or the token type doesn't expire
    // (some Convex tokens are long-lived).
    // If the server rejects it, the user needs to re-login.
  }

  // Validate against the server by calling GET /api/cli-credits
  // This is lightweight and also returns userId + email
  try {
    const resp = await fetch(`${API_BASE}/api/cli-credits`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (resp.status === 401) {
      // Token is definitively expired or invalid
      clearAuth();
      return {
        valid: false,
        userId: null,
        email: null,
        token,
        error:
          'Your authentication has expired. Please run `bna login` to re-authenticate.',
      };
    }

    if (!resp.ok) {
      // Server error — don't block the user, treat as potentially valid
      // (the actual API call will fail later if truly invalid)
      return {
        valid: true,
        userId: store.get('userId'),
        email: store.get('email'),
        token,
      };
    }

    const data = await resp.json();

    // Update local store with server-resolved identity
    if (data.userId) store.set('userId', data.userId);
    if (data.email) store.set('email', data.email);

    return {
      valid: true,
      userId: data.userId ?? null,
      email: data.email ?? null,
      token,
    };
  } catch {
    // Network error — don't block, let the user proceed
    // The actual API call will handle the error
    return {
      valid: true,
      userId: store.get('userId'),
      email: store.get('email'),
      token,
    };
  }
}

/**
 * Ensure the auth token is valid before proceeding.
 * Exits the process if authentication is invalid.
 *
 * Call this ONCE at the start of the build command, before any expensive work.
 */
export async function ensureValidAuth(): Promise<{
  userId: string;
  email: string | null;
  token: string;
}> {
  // 1. Check if user has ever logged in
  if (!store.get('authToken')) {
    log.error(
      'You are not logged in.\n' +
        '  Run ' +
        chalk.cyan('bna login') +
        ' to authenticate with BNA.',
    );
    process.exit(1);
  }

  // 2. Validate the token against the server
  log.info('Verifying authentication...');
  const auth = await validateAuthToken();

  if (!auth.valid) {
    log.error(auth.error ?? 'Authentication failed.');
    log.info(`Run ${chalk.cyan('bna login')} to re-authenticate.`);
    process.exit(1);
  }

  if (!auth.userId) {
    log.error(
      'Could not verify your identity. Your auth token may be expired.\n' +
        `  Run ${chalk.cyan('bna login')} to re-authenticate.`,
    );
    process.exit(1);
  }

  log.success(`Authenticated as ${chalk.cyan(auth.email ?? auth.userId)}`);

  return {
    userId: auth.userId,
    email: auth.email,
    token: auth.token,
  };
}
