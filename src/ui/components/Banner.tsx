import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function Banner(props: {
  model: string;
  stack: string;
  cwd: string;
  turn: number;
  credits?: number;
}) {
  const { model, stack, cwd, turn, credits } = props;
  return (
    <Box
      borderStyle='round'
      borderColor={theme.borderHot}
      paddingX={1}
      flexDirection='column'
    >
      <Text>
        <Text bold color={theme.accent}>
          BNA
        </Text>
        <Text color={theme.mute}> · </Text>
        {model}
        <Text color={theme.mute}> · </Text>
        {stack}
        <Text color={theme.mute}> · </Text>
        {cwd}
      </Text>
      <Text color={theme.mute}>
        Turn {turn}
        {credits != null ? ` · ${credits} credits` : ''} · /help for commands
      </Text>
    </Box>
  );
}
