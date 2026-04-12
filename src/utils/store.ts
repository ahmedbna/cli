// src/utils/store.ts
// Persistent config store using Conf (stores in ~/.config/bna-cli/)

import Conf from 'conf';

interface StoreSchema {
  authToken: string | null;
  userId: string | null;
  email: string | null;
  convexAccessToken: string | null;
  convexTeamSlug: string | null;
  // Long-lived session token (30-day TTL, set at login time)
  sessionExpiresAt: number | null;
  // Track when the JWT was last refreshed
  tokenRefreshedAt: number | null;
}

export const store = new Conf<StoreSchema>({
  projectName: 'bna-cli',
  schema: {
    authToken: { type: ['string', 'null'], default: null },
    userId: { type: ['string', 'null'], default: null },
    email: { type: ['string', 'null'], default: null },
    convexAccessToken: { type: ['string', 'null'], default: null },
    convexTeamSlug: { type: ['string', 'null'], default: null },
    sessionExpiresAt: { type: ['number', 'null'], default: null },
    tokenRefreshedAt: { type: ['number', 'null'], default: null },
  },
});

// 30 days in milliseconds
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isAuthenticated(): boolean {
  const token = store.get('authToken');
  if (!token) return false;

  // Check if the 30-day session has expired
  const expiresAt = store.get('sessionExpiresAt');
  if (expiresAt && Date.now() > expiresAt) {
    // Session expired — clear auth
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

/**
 * Check if the JWT inside the token is expired by decoding the payload.
 * Returns true if the token's `exp` claim is in the past.
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
  userId?: string;
  email?: string;
  convexAccessToken?: string;
  teamSlug?: string;
}): void {
  store.set('authToken', data.token);
  store.set('sessionExpiresAt', Date.now() + SESSION_TTL_MS);
  store.set('tokenRefreshedAt', Date.now());

  if (data.userId) store.set('userId', data.userId);
  if (data.email) store.set('email', data.email);
  if (data.convexAccessToken)
    store.set('convexAccessToken', data.convexAccessToken);
  if (data.teamSlug) store.set('convexTeamSlug', data.teamSlug);
}

export function getUserId(): string | null {
  return store.get('userId');
}

export function clearAuth(): void {
  store.set('authToken', null);
  store.set('userId', null);
  store.set('email', null);
  store.set('convexAccessToken', null);
  store.set('convexTeamSlug', null);
  store.set('sessionExpiresAt', null);
  store.set('tokenRefreshedAt', null);
}
