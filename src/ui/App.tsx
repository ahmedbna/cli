import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Static, useApp, useInput } from 'ink';
import { Banner } from './components/Banner.js';
import { MessageItem, type ChatItem } from './components/MessageItem.js';
import { InputBox } from './components/InputBox.js';
import { StatusBar } from './components/StatusBar.js';
import { SlashPalette } from './components/SlashPalette.js';
import { ClarifyPicker } from './components/ClarifyPicker.js';
import { on, type UiEvent } from './events.js';
import type { Session } from '../session/session.js';

export function App({
  session,
  onSubmit,
}: {
  session: Session;
  onSubmit: (text: string) => void;
}) {
  const [items, dispatch] = useReducer(itemsReducer, []);
  const [agentRunning, setRunning] = useState(false);
  const [pendingClarify, setClarify] = useState<null | {
    id: string;
    question: string;
    options?: string[];
  }>(null);
  const [draft, setDraft] = useState('');
  const app = useApp();

  useEffect(
    () =>
      on((e) => {
        dispatch(e);
        if (e.type === 'assistant-start') setRunning(true);
        if (e.type === 'turn-complete' || e.type === 'error') setRunning(false);
        if (e.type === 'clarify')
          setClarify({
            id: e.id,
            question: e.question,
            options: e.options,
          });
        if (e.type === 'clarify-answer') setClarify(null);
      }),
    [],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'd' && !agentRunning) {
      session.persist();
      app.exit();
    }
  });

  const showPalette = draft.startsWith('/') && !agentRunning;

  return (
    <Box flexDirection='column'>
      <Banner
        model='claude-opus-4-7'
        stack={session.stack}
        cwd={session.projectRoot}
        turn={session.getTurnCount()}
      />

      {/* Static renders each message once, so scrollback is preserved. */}
      <Static items={items}>
        {(item, i) => <MessageItem key={i} item={item} />}
      </Static>

      {pendingClarify && (
        <ClarifyPicker
          question={pendingClarify.question}
          options={pendingClarify.options}
          onAnswer={(ans) => onSubmit(ans)}
        />
      )}

      <Box marginTop={1}>
        {!pendingClarify && (
          <InputBox
            disabled={agentRunning}
            onSubmit={(text) => {
              onSubmit(text);
              setDraft('');
            }}
            placeholder={
              agentRunning
                ? 'agent is thinking…'
                : 'Message BNA…  (/ for commands)'
            }
          />
        )}
      </Box>

      {showPalette && (
        <SlashPalette
          filter={draft.slice(1)}
          onSelect={(cmd) => onSubmit(cmd)}
        />
      )}

      <StatusBar
        agentRunning={agentRunning}
        model='claude-opus-4-7'
        stack={session.stack}
        turn={session.getTurnCount()}
      />
    </Box>
  );
}

function itemsReducer(state: ChatItem[], e: UiEvent): ChatItem[] {
  switch (e.type) {
    case 'user':
      return [...state, { kind: 'user', text: e.text, ts: e.ts }];
    case 'assistant-start':
      return [
        ...state,
        { kind: 'assistant', id: e.id, text: '', streaming: true },
      ];
    case 'assistant-delta':
      return state.map((it) =>
        it.kind === 'assistant' && it.id === e.id
          ? { ...it, text: it.text + e.text }
          : it,
      );
    case 'assistant-end':
      return state.map((it) =>
        it.kind === 'assistant' && it.id === e.id
          ? { ...it, streaming: false }
          : it,
      );
    case 'tool-start':
      return [
        ...state,
        {
          kind: 'tool',
          id: e.id,
          name: e.name,
          input: e.input,
          state: 'running',
        },
      ];
    case 'tool-end':
      return state.map((it) =>
        it.kind === 'tool' && it.id === e.id
          ? {
              ...it,
              state: e.ok ? 'done' : 'error',
              resultPreview: e.resultPreview,
              diff: e.diff,
            }
          : it,
      );
    case 'spinner':
      return state.map((it) =>
        it.kind === 'assistant' && it.streaming
          ? {
              ...it,
              stats: {
                tokens: e.tokens,
                round: e.round,
                maxRounds: e.maxRounds,
                elapsedMs: e.elapsedMs,
              },
            }
          : it,
      );
    case 'info':
    case 'warn':
    case 'error':
    case 'success':
      return [...state, { kind: 'system', level: e.type, text: e.text }];
    default:
      return state;
  }
}
