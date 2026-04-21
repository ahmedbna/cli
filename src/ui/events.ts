// src/ui/events.ts
import { EventEmitter } from 'node:events';

export type UiEvent =
  | { type: 'user'; text: string; ts: number }
  | { type: 'assistant-start'; id: string; ts: number }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'assistant-end'; id: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | {
      type: 'tool-end';
      id: string;
      resultPreview: string;
      ok: boolean;
      diff?: { added: number; removed: number };
    }
  | {
      type: 'spinner';
      label?: string;
      tokens?: number;
      round?: number;
      maxRounds?: number;
      elapsedMs?: number;
    }
  | { type: 'spinner-stop' }
  | {
      type: 'op';
      kind: 'create' | 'update' | 'delete' | 'rename';
      path: string;
    }
  | { type: 'info' | 'warn' | 'error' | 'success'; text: string }
  | { type: 'clarify'; id: string; question: string; options?: string[] }
  | { type: 'clarify-answer'; id: string; answer: string }
  | { type: 'turn-complete'; summary?: string };

export const uiBus = new EventEmitter();
export const emit = (e: UiEvent) => uiBus.emit('ui', e);
export const on = (fn: (e: UiEvent) => void) => {
  uiBus.on('ui', fn);
  return () => uiBus.off('ui', fn);
};
