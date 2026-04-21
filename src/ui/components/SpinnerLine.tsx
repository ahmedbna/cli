import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme, verbs } from '../theme.js';

const TIPS = [
  'press / anywhere to open the command palette',
  'ctrl-c once interrupts, twice exits',
  '/undo reverts the last file op',
  'shift+↵ inserts a newline in the input',
];

export function SpinnerLine(props: {
  stats?: {
    tokens?: number;
    round?: number;
    maxRounds?: number;
    elapsedMs?: number;
    verb?: string;
  };
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const verb = props.stats?.verb ?? verbs[Math.floor(tick / 6) % verbs.length];
  const tip = TIPS[Math.floor(tick / 8) % TIPS.length];
  const elapsed =
    props.stats?.elapsedMs != null
      ? fmtDuration(props.stats.elapsedMs)
      : fmtDuration(tick * 1000);

  return (
    <Box flexDirection='column'>
      <Text>
        <Text color={theme.mute}>│ </Text>
        <Text color={theme.accent}>
          <Spinner type='dots' />
        </Text>
        <Text> {verb} </Text>
        <Text color={theme.mute}>· {elapsed}</Text>
        {props.stats?.tokens != null && (
          <Text color={theme.mute}> · ↓ {props.stats.tokens} tok</Text>
        )}
        {props.stats?.round != null && (
          <Text color={theme.mute}>
            {'  ·  round '}
            {props.stats.round}
            {props.stats.maxRounds ? `/${props.stats.maxRounds}` : ''}
          </Text>
        )}
      </Text>
      <Text>
        <Text color={theme.mute}>│ tip: {tip}</Text>
      </Text>
    </Box>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
