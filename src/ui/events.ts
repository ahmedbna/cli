// src/ui/events.ts
//
// The event bus decouples the agent/tool layer from the rendering layer.
// Agent code calls emit(...); Ink components subscribe via on(...).
//
// When the UI is not mounted (non-TTY, legacy REPL), emissions are silently
// ignored and the legacy stdout paths are used instead. That's governed by
// the `uiActive` flag — logger.ts / liveSpinner.ts / tools.ts check it.

import { EventEmitter } from 'node:events';

export type UiEvent =
  // User + assistant turn lifecycle
  | { type: 'user'; text: string; ts: number }
  | { type: 'assistant-start'; id: string; ts: number }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'assistant-end'; id: string }

  // Tool lifecycle — each tool call gets a start + end pair
  | {
      type: 'tool-start';
      id: string;
      name: string;
      label: string; // short inline descriptor e.g. "convex/schema.ts"
      extra?: string; // optional trailing info e.g. "(12 lines)"
    }
  | {
      type: 'tool-progress';
      id: string;
      line: string; // one line of streamed stdout/stderr
    }
  | {
      type: 'tool-end';
      id: string;
      ok: boolean;
      extra?: string; // final annotation e.g. "(12 lines)" or "failed"
    }

  // Agent thinking indicator (between tool calls)
  | {
      type: 'thinking-start';
      round: number;
      maxRounds: number;
    }
  | {
      type: 'thinking-tokens';
      tokens: number;
    }
  | { type: 'thinking-stop' }

  // Plain log lines
  | { type: 'info' | 'warn' | 'error' | 'success'; text: string }

  // Clarify (askUser) — rendered inline, user answers in next turn
  | { type: 'clarify'; id: string; question: string; options?: string[] }
  | { type: 'clarify-answer'; id: string; answer: string }

  // Turn lifecycle
  | { type: 'turn-complete'; summary?: string }

  // Generic "section divider" for visual breathing room
  | { type: 'divider' };

export const uiBus = new EventEmitter();
uiBus.setMaxListeners(50);

let _uiActive = false;

export function setUiActive(v: boolean): void {
  _uiActive = v;
}
export function isUiActive(): boolean {
  return _uiActive;
}

export function emit(e: UiEvent): void {
  if (!_uiActive) return;
  uiBus.emit('ui', e);
}

export function on(fn: (e: UiEvent) => void): () => void {
  uiBus.on('ui', fn);
  return () => uiBus.off('ui', fn);
}
