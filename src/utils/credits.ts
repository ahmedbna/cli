// src/utils/credits.ts
// Credits management via /api/cli-credits — authenticated with Bearer token

import { store, getAuthToken } from './store.js';
import { log } from './logger.js';

const API_BASE = 'https://ai.ahmedbna.com';

export async function checkCredits(): Promise<{
  credits: number;
  hasEnough: boolean;
  userId: string | null;
  email: string | null;
}> {
  try {
    const token = getAuthToken();

    const resp = await fetch(`${API_BASE}/api/cli-credits`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (resp.status === 401) {
      return { credits: 0, hasEnough: false, userId: null, email: null };
    }

    if (!resp.ok) {
      // Network issue — don't block the user
      return {
        credits: -1,
        hasEnough: true,
        userId: store.get('userId'),
        email: store.get('email'),
      };
    }

    const data = await resp.json();

    // Update local store with server-resolved identity
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
    // Network error — don't block
    return {
      credits: -1,
      hasEnough: true,
      userId: store.get('userId'),
      email: store.get('email'),
    };
  }
}

export async function deductCredits(
  inputTokens: number,
  outputTokens: number,
  chatInitialId?: string,
): Promise<void> {
  try {
    const token = getAuthToken();

    const resp = await fetch(`${API_BASE}/api/cli-credits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        chatInitialId: chatInitialId ?? `cli-${Date.now()}`,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.remainingCredits !== undefined) {
        log.credits(data.remainingCredits);
      }
    } else if (resp.status === 401) {
      log.warn('Auth token expired. Run `bna login` to re-authenticate.');
    }
  } catch {
    // Silent failure — don't break the flow for credit issues
  }
}
