// src/utils/credits.ts

import { store, getAuthToken, CONVEX_SITE_URL } from './store.js';

export async function checkCredits(): Promise<{
  credits: number;
  hasEnough: boolean;
  userId: string | null;
  email: string | null;
}> {
  try {
    const token = getAuthToken();

    const resp = await fetch(`${CONVEX_SITE_URL}/cli/credits`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status === 401) {
      return { credits: 0, hasEnough: false, userId: null, email: null };
    }

    if (!resp.ok) {
      return {
        credits: -1,
        hasEnough: true,
        userId: store.get('userId'),
        email: store.get('email'),
      };
    }

    const data = await resp.json();

    if (data.userId && data.userId !== store.get('userId')) {
      store.set('userId', data.userId);
    }
    if (data.email && data.email !== store.get('email')) {
      store.set('email', data.email);
    }

    return {
      credits: data.credits ?? 0,
      hasEnough: data.hasEnough ?? true,
      userId: data.userId ?? null,
      email: data.email ?? null,
    };
  } catch {
    return {
      credits: -1,
      hasEnough: true,
      userId: store.get('userId'),
      email: store.get('email'),
    };
  }
}
