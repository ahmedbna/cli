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

export async function deductCredits(
  inputTokens: number,
  outputTokens: number,
  chatInitialId?: string,
): Promise<void> {
  if (inputTokens <= 0 && outputTokens <= 0) {
    log.warn('No tokens to deduct — skipping credit deduction.');
    return;
  }

  let token: string;
  try {
    token = getAuthToken();
  } catch {
    log.warn('Not authenticated — cannot deduct credits.');
    return;
  }

  const body = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    chatInitialId: chatInitialId ?? `cli-${Date.now()}`,
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${API_BASE}/api/cli-credits`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.remainingCredits !== undefined) {
          log.credits(data.remainingCredits);
        }
        if (data.creditsDeducted !== undefined) {
          log.info(
            `Credits deducted: ${data.creditsDeducted} ` +
              `(${inputTokens.toLocaleString()} input + ${outputTokens.toLocaleString()} output tokens)`,
          );
        }
        return;
      } else if (resp.status === 401) {
        log.warn('Auth token expired. Run `bna login` to re-authenticate.');
        return;
      } else {
        const errorText = await resp.text().catch(() => 'unknown error');
        log.warn(
          `Credit deduction failed (attempt ${attempt}/3): HTTP ${resp.status} — ${errorText}`,
        );
      }
    } catch (err: any) {
      log.warn(
        `Credit deduction failed (attempt ${attempt}/3): ${err.message ?? 'network error'}`,
      );
    }

    if (attempt < 3) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt - 1) * 1000),
      );
    }
  }

  log.warn(
    'Could not deduct credits after 3 attempts. Usage will be reconciled on next login.',
  );
}
