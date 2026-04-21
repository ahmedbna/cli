import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { theme } from '../theme.js';

const COMMANDS = [
  { label: '/help      show commands', value: '/help' },
  { label: '/status    project, stack, turn count', value: '/status' },
  { label: '/history   last 20 file operations', value: '/history' },
  { label: '/undo      revert last change', value: '/undo' },
  { label: '/modify    guide a modification', value: '/modify' },
  { label: '/continue  pick up from where agent left off', value: '/continue' },
  { label: '/finalize  run build + finalize', value: '/finalize' },
  { label: '/clear     clear the screen', value: '/clear' },
  { label: '/exit      save & quit', value: '/exit' },
];

export function SlashPalette(props: {
  filter: string;
  onSelect: (cmd: string) => void;
}) {
  const items = COMMANDS.filter((c) =>
    c.value.slice(1).toLowerCase().startsWith(props.filter.toLowerCase()),
  );
  if (items.length === 0) return null;
  return (
    <Box
      borderStyle='round'
      borderColor={theme.border}
      flexDirection='column'
      paddingX={1}
    >
      <Text color={theme.mute}>commands</Text>
      <SelectInput items={items} onSelect={(i) => props.onSelect(i.value)} />
    </Box>
  );
}
