import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function StatusBar(props: {
  agentRunning: boolean;
  model: string;
  stack: string;
  turn: number;
  credits?: number;
  hint?: string;
}) {
  return (
    <Box justifyContent='space-between' paddingX={1}>
      <Text color={theme.mute}>
        {props.agentRunning ? (
          <>
            <Text color={theme.accent}>●</Text> agent running · ctrl-c to
            interrupt
          </>
        ) : (
          <>{props.hint ?? 'ready'}</>
        )}
      </Text>
      <Text color={theme.mute}>
        {props.model} · {props.stack} · turn {props.turn}
        {props.credits != null ? ` · ${props.credits}¢` : ''}
      </Text>
    </Box>
  );
}
