// src/utils/apiClient.ts
//
// Shared HTTP client for the `/cli/chat` agent endpoint. Centralises:
//   - the POST body shape
//   - retry-with-backoff for transient 5xx responses
//   - friendly error messages for upstream failures (so we never dump a raw
//     Cloudflare HTML page into the user's terminal)
//
// All four agents (architect, backend, frontend, single-agent follow-up) go
// through these helpers.

import { CONVEX_SITE_URL } from './store.js';
import { emit, isUiActive } from '../ui/events.js';
import { log } from './logger.js';

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_FETCH_RETRIES = 3;

export interface FetchStreamOptions {
  /** Optional cancel signal — if it returns true, the retry loop bails out
   *  and returns the most recent response (or throws if there is none). */
  isInterrupted?: () => boolean;
  /** Label for retry/log messages, e.g. "Architect", "Backend". Defaults to "Backend". */
  label?: string;
}

export async function fetchStream(
  authToken: string,
  systemPrompt: string,
  messages: any[],
  tools: any[],
): Promise<Response> {
  return fetch(`${CONVEX_SITE_URL}/cli/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ system: systemPrompt, messages, tools }),
  });
}

export async function fetchStreamWithRetry(
  authToken: string,
  systemPrompt: string,
  messages: any[],
  tools: any[],
  opts: FetchStreamOptions = {},
): Promise<Response> {
  const { isInterrupted, label = 'Backend' } = opts;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
    if (isInterrupted?.()) {
      if (lastResponse) return lastResponse;
      throw new Error('interrupted');
    }

    const response = await fetchStream(authToken, systemPrompt, messages, tools);

    if (!RETRYABLE_STATUSES.has(response.status)) return response;
    lastResponse = response;

    // Drain the body so the connection can be released cleanly.
    try {
      await response.text();
    } catch {
      /* noop */
    }

    if (attempt < MAX_FETCH_RETRIES - 1) {
      const delay = 1000 * Math.pow(2, attempt);
      const msg = `${label} returned ${response.status} — retrying in ${delay / 1000}s (attempt ${attempt + 2}/${MAX_FETCH_RETRIES})...`;
      if (isUiActive()) emit({ type: 'warn', text: msg });
      else log.warn(msg);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return lastResponse!;
}

/**
 * Turn a non-OK Response into a short, user-facing error string. Strips raw
 * HTML from upstream proxies (Cloudflare, nginx) so users see something like
 * "Server unavailable (502)" instead of a 5KB DOCTYPE dump.
 */
export async function extractErrorMessage(response: Response): Promise<string> {
  const status = response.status;
  const statusText = response.statusText || '';

  if (status === 502)
    return 'Server unavailable (502). The backend is temporarily unreachable. Please try again in a moment.';
  if (status === 503)
    return 'Service temporarily unavailable (503). Please try again.';
  if (status === 504) return 'Upstream timeout (504). Please try again.';
  if (status === 429)
    return 'Rate limited (429). Please wait a few seconds and try again.';

  const ct = response.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const j = await response.json();
      return (
        j.error ?? j.message ?? `API request failed (${status} ${statusText})`
      );
    }
    const text = await response.text();
    if (
      ct.includes('text/html') ||
      /<!DOCTYPE|<html/i.test(text.slice(0, 100))
    ) {
      return `API request failed (${status} ${statusText || 'error'}).`;
    }
    const preview = text.trim().slice(0, 300);
    return `API request failed (${status}): ${preview}${text.length > 300 ? '...' : ''}`;
  } catch {
    return `API request failed (${status} ${statusText})`;
  }
}
