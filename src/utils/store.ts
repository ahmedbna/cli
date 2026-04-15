// src/utils/store.ts
//
// Persistent config store using Conf (stores in ~/.config/bna-cli/).
//
// Token strategy:
//   - authToken: Convex auth JWT (short-lived, ~1 hour)
//   - refreshToken: Convex refresh token (long-lived, used to get new auth tokens)
//   - sessionExpiresAt: 30-day CLI session window (after this, user must `bna login` again)

import Conf from 'conf';

interface StoreSchema {
  /** Convex auth JWT (short-lived) */
  authToken: string | null;
  /** Convex refresh token (long-lived) */
  refreshToken: string | null;
  /** Convex user ID */
  userId: string | null;
  /** User email */
  email: string | null;
  /** Convex OAuth access token for team operations */
  convexAccessToken: string | null;
  /** Convex team slug */
  convexTeamSlug: string | null;
  /** 30-day session window expiry (CLI-side enforcement) */
  sessionExpiresAt: number | null;
  /** Convex site URL for API calls */
  convexSiteUrl: string | null;
}

export const store = new Conf<StoreSchema>({
  projectName: 'bna-cli',
  schema: {
    authToken: { type: ['string', 'null'], default: null },
    refreshToken: { type: ['string', 'null'], default: null },
    userId: { type: ['string', 'null'], default: null },
    email: { type: ['string', 'null'], default: null },
    convexAccessToken: { type: ['string', 'null'], default: null },
    convexTeamSlug: { type: ['string', 'null'], default: null },
    sessionExpiresAt: { type: ['number', 'null'], default: null },
    convexSiteUrl: { type: ['string', 'null'], default: null },
  },
});

// 30 days in milliseconds
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const CONVEX_SITE_URL = 'https://chatty-owl-80.convex.site';

export function isAuthenticated(): boolean {
  const token = store.get('authToken');
  if (!token) return false;

  // Check if the 30-day session has expired
  const expiresAt = store.get('sessionExpiresAt');
  if (expiresAt && Date.now() > expiresAt) {
    clearAuth();
    return false;
  }

  return true;
}

export function getAuthToken(): string {
  const token = store.get('authToken');
  if (!token) throw new Error('Not authenticated. Run `bna login` first.');

  // Check if the 30-day session has expired
  const expiresAt = store.get('sessionExpiresAt');
  if (expiresAt && Date.now() > expiresAt) {
    clearAuth();
    throw new Error(
      'Session expired (30 days). Run `bna login` to re-authenticate.',
    );
  }

  return token;
}

export function getRefreshToken(): string | null {
  return store.get('refreshToken');
}

/**
 * Check if the auth JWT is expired by decoding the payload.
 * Returns true if the token's `exp` claim is in the past (with 60s buffer).
 */
export function isTokenExpired(): boolean {
  const token = store.get('authToken');
  if (!token) return true;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );

    if (!payload.exp) return false; // No expiry claim — treat as valid

    const nowSec = Math.floor(Date.now() / 1000);
    // Add 60s buffer to refresh before actual expiry
    return payload.exp < nowSec + 60;
  } catch {
    return true;
  }
}

/**
 * Set auth data after a successful login.
 * Sets a 30-day session expiry.
 */
export function setAuthData(data: {
  token: string;
  refreshToken: string;
  userId?: string;
  email?: string;
  convexAccessToken?: string;
  teamSlug?: string;
  convexSiteUrl?: string;
}): void {
  store.set('authToken', data.token);
  store.set('refreshToken', data.refreshToken);
  store.set('sessionExpiresAt', Date.now() + SESSION_TTL_MS);

  if (data.userId) store.set('userId', data.userId);
  if (data.email) store.set('email', data.email);
  if (data.convexAccessToken)
    store.set('convexAccessToken', data.convexAccessToken);
  if (data.teamSlug) store.set('convexTeamSlug', data.teamSlug);
  if (data.convexSiteUrl) store.set('convexSiteUrl', data.convexSiteUrl);
}

/**
 * Update the auth token after a successful refresh.
 * Preserves the existing session expiry and other fields.
 */
export function updateAuthToken(token: string, refreshToken?: string): void {
  store.set('authToken', token);
  if (refreshToken) {
    store.set('refreshToken', refreshToken);
  }
}

export function getUserId(): string | null {
  return store.get('userId');
}

export function clearAuth(): void {
  store.set('authToken', null);
  store.set('refreshToken', null);
  store.set('userId', null);
  store.set('email', null);
  store.set('convexAccessToken', null);
  store.set('convexTeamSlug', null);
  store.set('sessionExpiresAt', null);
  store.set('convexSiteUrl', null);
}
