// src/ui/components/SlashPalette.tsx
//
// Inline slash-command palette. Renders just above the input when the user's
// draft starts with `/`. Fuzzy-filtered by the text after the slash.
// Selection fires onSelect(command) which dispatches into the REPL.

import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { theme } from '../theme.js';

const COMMANDS = [
  { label: 'help      show this help', value: '/help' },
  { label: 'status    session state + recent changes', value: '/status' },
  { label: 'history   last 20 file operations', value: '/history' },
  { label: 'undo      revert last change', value: '/undo' },
  { label: 'modify    guide a modification', value: '/modify' },
  { label: 'continue  pick up where agent left off', value: '/continue' },
  { label: 'finalize  run build + finalize', value: '/finalize' },
  { label: 'clear     clear the screen', value: '/clear' },
  { label: 'exit      save & quit', value: '/exit' },
];

export function SlashPalette({
  filter,
  onSelect,
}: {
  filter: string;
  onSelect: (cmd: string) => void;
}) {
  const items = COMMANDS.filter((c) =>
    c.value.slice(1).toLowerCase().startsWith(filter.toLowerCase()),
  ).map((c) => ({
    label: `  ${c.value.padEnd(12)} ${c.label.slice(c.label.indexOf(' ')).trim()}`,
    value: c.value,
  }));

  if (items.length === 0) return null;

  return (
    <Box flexDirection='column' marginTop={1}>
      <Text color={theme.mute}>commands</Text>
      <SelectInput items={items} onSelect={(i) => onSelect(i.value)} />
    </Box>
  );
}
