// src/utils/auth.ts
//
// Token validation and refresh utilities for the BNA CLI.
//
// Uses Convex's native auth tokens:
//   - Auth token: short-lived JWT from @convex-dev/auth (~1 hour)
//   - Refresh token: long-lived token used to get new auth tokens
//
// The refresh endpoint is a Convex HTTP action at /cli/refresh.
// No custom JWT signing — all token management is handled by Convex.

import {
  store,
  getAuthToken,
  getRefreshToken,
  isTokenExpired,
  clearAuth,
  updateAuthToken,
  CONVEX_SITE_URL,
} from './store.js';
import { log } from './logger.js';
import chalk from 'chalk';

export interface AuthValidation {
  valid: boolean;
  userId: string | null;
  email: string | null;
  token: string;
  error?: string;
}

/**
 * Refresh the auth token using the stored refresh token.
 * Calls the Convex HTTP action at /cli/refresh.
 *
 * Returns the new auth token if successful, or null if refresh failed.
 */
export async function refreshAuthToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    log.warn('No refresh token available. Run `bna login` to re-authenticate.');
    return null;
  }

  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/cli/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.token) {
        updateAuthToken(data.token, data.refreshToken);
        return data.token;
      }
    }

    if (resp.status === 401) {
      log.warn('Refresh token expired. Run `bna login` to re-authenticate.');
      return null;
    }

    return null;
  } catch {
    // Network error — can't refresh
    return null;
  }
}

/**
 * Validate the stored auth token.
 * If the JWT is expired, attempts to refresh it first.
 * Then validates against the Convex credits endpoint.
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
  if (isTokenExpired()) {
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
    // Refresh failed — token is expired and can't be refreshed
    clearAuth();
    return {
      valid: false,
      userId: null,
      email: null,
      token,
      error: 'Authentication expired. Run `bna login` to re-authenticate.',
    };
  }

  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/cli/credits`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status === 401) {
      // Token rejected — try refresh
      const refreshedToken = await refreshAuthToken();
      if (refreshedToken) {
        return {
          valid: true,
          userId: store.get('userId'),
          email: store.get('email'),
          token: refreshedToken,
        };
      }

      clearAuth();
      return {
        valid: false,
        userId: null,
        email: null,
        token,
        error: 'Authentication expired. Run `bna login` to re-authenticate.',
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
    // Network error — let the user proceed with current token
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

  // If token looks expired, try refreshing
  if (isTokenExpired()) {
    log.info('Token expired during setup, refreshing...');
    const refreshed = await refreshAuthToken();
    if (refreshed) {
      log.success('Token refreshed.');
      return refreshed;
    }
  }

  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/cli/credits`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    });

    if (resp.status === 401) {
      // Try refresh
      const refreshed = await refreshAuthToken();
      if (refreshed) {
        log.success('Token refreshed.');
        return refreshed;
      }

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
