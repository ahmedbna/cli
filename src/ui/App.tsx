// src/ui/App.tsx
//
// The root Ink component. Layout:
//
//   ┌────────────────────────────────────────────────────────┐
//   │  [Static] past messages — rendered once, never updates │  ← scrollback
//   │  > Add a streak counter                                │
//   │  ● Reading convex/schema.ts                            │
//   │  ● Editing app/(tabs)/index.tsx (+12 -0)               │
//   │  I've added a streak field and wired it to the home... │
//   │                                                        │
//   │  [Live] in-flight assistant + active tool lines        │  ← live region
//   │  ● Editing app/(tabs)/index.tsx          ← still updating
//   │  ⠙ Thinking  7s · ↓ 412 tok · round 2/30               │
//   │                                                        │
//   │  [Input] › Message BNA  (/ for commands)               │  ← prompt
//   └────────────────────────────────────────────────────────┘
//
// The Static/Live split is important: <Static> doesn't re-render, so long
// sessions don't get slow and the user can scroll back through the full
// history. Only the live region and input re-render on each event.

import React, { useEffect, useReducer, useState } from 'react';
import { Box, Static, useApp, useInput } from 'ink';
import {
  AssistantLine,
  Divider,
  SystemLine,
  UserLine,
} from './components/Lines.js';
import { ToolLine, type ToolLineItem } from './components/ToolLine.js';
import { Thinking } from './components/Thinking.js';
import { Input } from './components/Input.js';
import { SlashPalette } from './components/SlashPalette.js';
import { ClarifyPicker } from './components/ClarifyPicker.js';
import { on, type UiEvent } from './events.js';

// ─── Item model ────────────────────────────────────────────────────────────
//
// Every renderable block in the chat log is one of these. The reducer
// splits them into "finalized" (in Static) and "live" (below Static),
// based on their `streaming` flag.

type StaticItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool'; key: string; item: ToolLineItem }
  | {
      kind: 'system';
      key: string;
      level: 'info' | 'warn' | 'error' | 'success';
      text: string;
    }
  | { kind: 'divider'; key: string };

interface State {
  /** Finalized items — go into <Static>, never re-render. */
  finalized: StaticItem[];
  /** Live assistant text currently streaming (null when not streaming). */
  liveAssistant: { id: string; text: string } | null;
  /** Live tool calls currently running. Keyed by id, preserves order. */
  liveTools: Map<string, ToolLineItem>;
  /** Thinking indicator state, or null when idle. */
  thinking: {
    round: number;
    maxRounds: number;
    tokens: number;
    startedAt: number;
  } | null;
  /** Monotonic counter for react keys. */
  seq: number;
}

function initialState(): State {
  return {
    finalized: [],
    liveAssistant: null,
    liveTools: new Map(),
    thinking: null,
    seq: 0,
  };
}

function reducer(state: State, e: UiEvent): State {
  switch (e.type) {
    // ── User message: finalizes immediately ──────────────────────────────
    case 'user':
      return {
        ...state,
        finalized: [
          ...state.finalized,
          { kind: 'user', key: `u-${state.seq}`, text: e.text },
        ],
        seq: state.seq + 1,
      };

    // ── Assistant streaming ──────────────────────────────────────────────
    case 'assistant-start':
      // If there was a previous live assistant that never ended (shouldn't
      // happen but be defensive), flush it to finalized first.
      return flushLiveAssistant({
        ...state,
        liveAssistant: { id: e.id, text: '' },
      });
    case 'assistant-delta':
      if (!state.liveAssistant || state.liveAssistant.id !== e.id) return state;
      return {
        ...state,
        liveAssistant: {
          ...state.liveAssistant,
          text: state.liveAssistant.text + e.text,
        },
      };
    case 'assistant-end':
      if (!state.liveAssistant || state.liveAssistant.id !== e.id) return state;
      return flushLiveAssistant(state);

    // ── Tool lifecycle ───────────────────────────────────────────────────
    case 'tool-start': {
      const liveTools = new Map(state.liveTools);
      liveTools.set(e.id, {
        id: e.id,
        name: e.name,
        label: e.label,
        extra: undefined,
        state: 'running',
        progress: [],
      });
      return { ...state, liveTools };
    }
    case 'tool-progress': {
      const existing = state.liveTools.get(e.id);
      if (!existing) return state;
      const liveTools = new Map(state.liveTools);
      liveTools.set(e.id, {
        ...existing,
        progress: [...(existing.progress ?? []), e.line].slice(-5),
      });
      return { ...state, liveTools };
    }
    case 'tool-end': {
      const existing = state.liveTools.get(e.id);
      if (!existing) return state;
      // Finalize: move from liveTools → finalized. We drop the progress lines
      // at finalization time (they've served their purpose; keeping them
      // would clutter scrollback).
      const finalized: ToolLineItem = {
        ...existing,
        state: e.ok ? 'done' : 'error',
        extra: e.extra ?? existing.extra,
        progress: undefined,
      };
      const liveTools = new Map(state.liveTools);
      liveTools.delete(e.id);
      return {
        ...state,
        liveTools,
        finalized: [
          ...state.finalized,
          { kind: 'tool', key: `t-${e.id}`, item: finalized },
        ],
      };
    }

    // ── Thinking ────────────────────────────────────────────────────────
    case 'thinking-start':
      return {
        ...state,
        thinking: {
          round: e.round,
          maxRounds: e.maxRounds,
          tokens: 0,
          startedAt: Date.now(),
        },
      };
    case 'thinking-tokens':
      if (!state.thinking) return state;
      return { ...state, thinking: { ...state.thinking, tokens: e.tokens } };
    case 'thinking-stop':
      return { ...state, thinking: null };

    // ── Plain log lines ─────────────────────────────────────────────────
    case 'info':
    case 'warn':
    case 'error':
    case 'success':
      return {
        ...state,
        finalized: [
          ...state.finalized,
          {
            kind: 'system',
            key: `s-${state.seq}`,
            level: e.type,
            text: e.text,
          },
        ],
        seq: state.seq + 1,
      };

    case 'divider':
      return {
        ...state,
        finalized: [
          ...state.finalized,
          { kind: 'divider', key: `d-${state.seq}` },
        ],
        seq: state.seq + 1,
      };

    // Lifecycle events with no direct render impact
    case 'turn-complete':
    case 'clarify':
    case 'clarify-answer':
      return state;

    default:
      return state;
  }
}

function flushLiveAssistant(state: State): State {
  if (!state.liveAssistant) return state;
  const { text } = state.liveAssistant;
  if (!text.trim()) {
    // Empty assistant turn (pure tool calls) — don't clutter with a blank line
    return { ...state, liveAssistant: null };
  }
  return {
    ...state,
    liveAssistant: null,
    finalized: [
      ...state.finalized,
      { kind: 'assistant', key: `a-${state.seq}`, text },
    ],
    seq: state.seq + 1,
  };
}

// ─── App ───────────────────────────────────────────────────────────────────

export interface AppProps {
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  agentRunning: boolean;
  pendingClarify: { id: string; question: string; options?: string[] } | null;
  onClarifyAnswer: (answer: string) => void;
}

export function App({
  onSubmit,
  onInterrupt,
  agentRunning,
  pendingClarify,
  onClarifyAnswer,
}: AppProps) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [draft, setDraft] = useState('');
  const { exit } = useApp();

  // Subscribe to the event bus
  useEffect(() => {
    const off = on((e) => dispatch(e));
    return () => off();
  }, []);

  // Keyboard shortcuts:
  //   esc       → interrupt current agent turn
  //   ctrl+c    → exit (only when input is enabled, i.e. agent not running)
  useInput((input, key) => {
    if (key.escape && agentRunning) {
      onInterrupt();
      return;
    }
    if (key.ctrl && input === 'c' && !agentRunning) {
      exit();
    }
  });

  const showPalette = !agentRunning && draft.startsWith('/');

  // Convert finalized items into the Static input. Ink's <Static> takes an
  // items array and only renders newly-appended entries, so scrollback is
  // preserved for the whole session regardless of length.
  return (
    <Box flexDirection='column'>
      {/* Finalized, scrollback-safe history */}
      <Static items={state.finalized}>{(item) => renderStatic(item)}</Static>

      {/* Live region — re-renders on every event */}
      {Array.from(state.liveTools.values()).map((t) => (
        <ToolLine key={`live-${t.id}`} item={t} />
      ))}

      {state.liveAssistant && state.liveAssistant.text && (
        <AssistantLine text={state.liveAssistant.text} streaming />
      )}

      {state.thinking && (
        <Thinking
          round={state.thinking.round}
          maxRounds={state.thinking.maxRounds}
          tokens={state.thinking.tokens}
          startedAt={state.thinking.startedAt}
        />
      )}

      {/* Clarify picker takes precedence over the input when present */}
      {pendingClarify ? (
        <ClarifyPicker
          question={pendingClarify.question}
          options={pendingClarify.options}
          onAnswer={onClarifyAnswer}
        />
      ) : (
        <>
          <Input
            value={draft}
            onChange={setDraft}
            onSubmit={(text) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              setDraft('');
              onSubmit(trimmed);
            }}
            disabled={agentRunning}
          />
          {showPalette && (
            <SlashPalette
              filter={draft.slice(1)}
              onSelect={(cmd) => {
                setDraft('');
                onSubmit(cmd);
              }}
            />
          )}
        </>
      )}
    </Box>
  );
}

function renderStatic(item: StaticItem): React.ReactElement {
  switch (item.kind) {
    case 'user':
      return <UserLine key={item.key} text={item.text} />;
    case 'assistant':
      return (
        <AssistantLine key={item.key} text={item.text} streaming={false} />
      );
    case 'tool':
      return <ToolLine key={item.key} item={item.item} />;
    case 'system':
      return <SystemLine key={item.key} level={item.level} text={item.text} />;
    case 'divider':
      return <Divider key={item.key} />;
  }
}
