// src/ui/components/Thinking.tsx
//
// Live "Thinking..." indicator. Single animated line with:
//   - Spinner
//   - Rotating verb (Thinking → Cooking → Wiring → ...)
//   - Elapsed seconds (MM:SS)
//   - Token counter (optional, from SSE usage)
//   - Round counter (optional)
//
// Example:
//   ⠙ Thinking  12s · ↓ 412 tok · round 2/30
//
// The verb rotates every 6 seconds so long thinks feel alive.

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme, verbs } from '../theme.js';

export function Thinking({
  round,
  maxRounds,
  tokens,
  startedAt,
}: {
  round: number;
  maxRounds: number;
  tokens?: number;
  startedAt: number;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const verb = verbs[Math.floor(elapsedSec / 6) % verbs.length];

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');
  const elapsed = elapsedSec < 60 ? `${elapsedSec}s` : `${mm}:${ss}`;

  return (
    <Box marginTop={1}>
      <Text color={theme.accent}>
        <Spinner type='dots' />
      </Text>
      <Text color={theme.assistant}> {verb}</Text>
      <Text color={theme.mute}>
        {'  '}
        {elapsed}
      </Text>
      {typeof tokens === 'number' && tokens > 0 && (
        <Text color={theme.mute}>
          {'  · ↓ '}
          {tokens.toLocaleString()} tok
        </Text>
      )}
      {round > 0 && (
        <Text color={theme.mute}>
          {'  · round '}
          {round}
          {maxRounds ? `/${maxRounds}` : ''}
        </Text>
      )}
      <Text color={theme.mute}>{'  · esc to interrupt'}</Text>
    </Box>
  );
}
