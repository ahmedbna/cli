// src/utils/credits.ts
//
// Credits management via Convex HTTP actions.
// All credit operations go through the Convex site URL — no Remix API routes.

import { store, getAuthToken, CONVEX_SITE_URL } from './store.js';
import { log } from './logger.js';

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

/**
 * Credit deduction is now handled server-side in the /cli/chat endpoint.
 * This function exists for backward compatibility but is largely a no-op —
 * credits are deducted atomically by the Convex HTTP action after streaming.
 */
export async function deductCredits(
  inputTokens: number,
  outputTokens: number,
  _chatInitialId?: string,
): Promise<void> {
  if (inputTokens <= 0 && outputTokens <= 0) {
    return;
  }

  // Credits are deducted server-side in the /cli/chat proxy.
  // This callback is for CLI-side logging/confirmation only.
  log.info(
    `Server deducted credits for ${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output tokens`,
  );
}
