// src/utils/store.ts
// Persistent config store using Conf (stores in ~/.config/bna-cli/)

import Conf from 'conf';

interface StoreSchema {
  authToken: string | null;
  userId: string | null;
  email: string | null;
  convexAccessToken: string | null;
  convexTeamSlug: string | null;
  anthropicApiKey: string | null;
  apiBaseUrl: string;
}

export const store = new Conf<StoreSchema>({
  projectName: 'bna-cli',
  schema: {
    authToken: { type: ['string', 'null'], default: null },
    userId: { type: ['string', 'null'], default: null },
    email: { type: ['string', 'null'], default: null },
    convexAccessToken: { type: ['string', 'null'], default: null },
    convexTeamSlug: { type: ['string', 'null'], default: null },
    anthropicApiKey: { type: ['string', 'null'], default: null },
    apiBaseUrl: {
      type: 'string',
      default: 'https://ai.ahmedbna.com',
    },
  },
});

export function isAuthenticated(): boolean {
  return store.get('authToken') !== null;
}

export function getAuthToken(): string {
  const token = store.get('authToken');
  if (!token) throw new Error('Not authenticated. Run `bna login` first.');
  return token;
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
}
