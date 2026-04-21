// src/ui/components/Lines.tsx
//
// The three simple inline message types: user, assistant, system.
// Everything is plain text with color — no boxes, no borders.
// This is the "Claude Code minimal" look.

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

// ─── User message ───────────────────────────────────────────────────────────
//
//   > Add a streak counter to the home screen.
//
// Blue prompt marker, then the user's text verbatim.

export function UserLine({ text }: { text: string }) {
  return (
    <Box flexDirection='column' marginTop={1}>
      {text.split('\n').map((line, i) => (
        <Text key={i}>
          <Text color={theme.user} bold>
            {i === 0 ? '> ' : '  '}
          </Text>
          <Text color={theme.assistant}>{line}</Text>
        </Text>
      ))}
    </Box>
  );
}

// ─── Assistant message ──────────────────────────────────────────────────────
//
// Just the text, unindented, near-white. No avatar/label — the tool lines
// and thinking indicator around it already make clear who's talking.

export function AssistantLine({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  if (!text && !streaming) return null;
  return (
    <Box flexDirection='column' marginTop={1}>
      {text.split('\n').map((line, i) => (
        <Text key={i} color={theme.assistant}>
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}

// ─── System line ────────────────────────────────────────────────────────────
//
//   ✓ Generated 12 files
//   ⚠ npm install failed
//   ✗ Turn failed: network error
//
// Colored glyph + message. Used for info/warn/error/success.

export function SystemLine({
  level,
  text,
}: {
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
}) {
  const { glyph, color } = (() => {
    switch (level) {
      case 'success':
        return { glyph: '✓', color: theme.ok };
      case 'warn':
        return { glyph: '⚠', color: theme.warn };
      case 'error':
        return { glyph: '✗', color: theme.err };
      default:
        return { glyph: 'ℹ', color: theme.mute };
    }
  })();
  return (
    <Box>
      <Text color={color}>{glyph} </Text>
      <Text color={level === 'error' ? theme.err : theme.assistant}>
        {text}
      </Text>
    </Box>
  );
}

// ─── Divider ────────────────────────────────────────────────────────────────

export function Divider() {
  return (
    <Box marginY={1}>
      <Text color={theme.mute}>{'─'.repeat(60)}</Text>
    </Box>
  );
}
