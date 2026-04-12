// src/utils/auth.ts
// Token validation and refresh utilities for the BNA CLI.
//
// The CLI now uses long-lived CLI JWTs (30-day expiry) signed by the server.
// These replace the short-lived Convex auth JWTs that were expiring during
// the 5+ minute build setup process.
//
// Flow:
//   1. `bna login` → browser auth → server issues CLI JWT (30 days)
//   2. `bna build` → ensureValidAuth() validates token before expensive work
//   3. After npm install + Convex setup → revalidateAuth() refreshes if needed
//   4. Agent runs with the fresh token
//   5. If 401 mid-session → agent calls refreshAuthToken() and retries

import {
  store,
  getAuthToken,
  isTokenExpired,
  clearAuth,
  setAuthData,
} from './store.js';
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
 * Attempt to refresh the auth token by calling POST /api/cli-auth (refresh).
 * The server verifies the old token's signature (ignoring expiry), confirms
 * the user still exists, and issues a fresh 30-day CLI JWT.
 *
 * Returns the new token if successful, or null if refresh failed.
 */
export async function refreshAuthToken(): Promise<string | null> {
  const currentToken = store.get('authToken');
  if (!currentToken) return null;

  try {
    const resp = await fetch(`${API_BASE}/api/cli-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentToken}`,
      },
      body: JSON.stringify({ action: 'refresh' }),
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.token) {
        // Store the fresh token
        setAuthData({
          token: data.token,
          userId: data.userId ?? store.get('userId') ?? undefined,
          email: data.email ?? store.get('email') ?? undefined,
        });
        log.success('Auth token refreshed.');
        return data.token;
      }
    }

    // 401 = token is too old to refresh, user needs to re-login
    if (resp.status === 401) {
      return null;
    }

    // Other errors (404 = endpoint doesn't exist yet, etc.)
    return null;
  } catch {
    // Network error — can't refresh
    return null;
  }
}

/**
 * Validate the stored auth token against the BNA server.
 * If the JWT is expired, attempts to refresh it first.
 * Returns the validation result with a fresh token if available.
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
    // Try to refresh the token before hitting the server
    const refreshedToken = await refreshAuthToken();
    if (refreshedToken) {
      token = refreshedToken;
      return {
        valid: true,
        userId: store.get('userId'),
        email: store.get('email'),
        token,
      };
    }
    // Refresh failed — fall through to server validation
  }

  // Validate against the server by calling GET /api/cli-credits
  try {
    const resp = await fetch(`${API_BASE}/api/cli-credits`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (resp.status === 401) {
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
      // Server error — don't block, treat as potentially valid
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
    // Network error — let the user proceed
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
 * Returns the fresh token for downstream use.
 */
export async function ensureValidAuth(): Promise<{
  userId: string;
  email: string | null;
  token: string;
}> {
  if (!store.get('authToken')) {
    log.error(
      'You are not logged in.\n' +
        '  Run ' +
        chalk.cyan('bna login') +
        ' to authenticate with BNA.',
    );
    process.exit(1);
  }

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

/**
 * Re-validate and refresh the auth token after a long setup process.
 * Called between Convex setup and agent start (5+ minutes may have elapsed).
 * Returns a fresh token or exits if auth is irrecoverable.
 */
export async function revalidateAuth(): Promise<string> {
  const currentToken = store.get('authToken');
  if (!currentToken) {
    log.error('Not authenticated. Run `bna login` first.');
    process.exit(1);
  }

  // 1. If token looks expired, try refreshing
  if (isTokenExpired()) {
    log.info('Token expired during setup, attempting refresh...');
    const refreshed = await refreshAuthToken();
    if (refreshed) return refreshed;
  }

  // 2. Validate against server
  try {
    const resp = await fetch(`${API_BASE}/api/cli-credits`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });

    if (resp.status === 401) {
      // Last chance: try refresh even if local check said it wasn't expired
      const refreshed = await refreshAuthToken();
      if (refreshed) return refreshed;

      log.error(
        'Your authentication expired during setup.\n' +
          `  Run ${chalk.cyan('bna login')} to re-authenticate, then run ${chalk.cyan('bna build')} again.\n` +
          '  Your project scaffolding is preserved — no work was lost.',
      );
      process.exit(1);
    }

    if (resp.ok) {
      const data = await resp.json();
      if (data.userId) store.set('userId', data.userId);
      if (data.email) store.set('email', data.email);
    }

    log.success('Authentication verified.');
    return currentToken;
  } catch {
    log.warn('Could not re-verify auth — proceeding with current token.');
    return currentToken;
  }
}
