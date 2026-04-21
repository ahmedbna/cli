// src/ui/components/ClarifyPicker.tsx
//
// When the agent calls the `askUser` tool, the loop pauses and this picker
// takes over the input area until the user answers. We don't use inquirer
// here — inquirer owns stdin and would fight the Ink app. Pure Ink select +
// text input keeps everything under one render tree.

import React, { useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

export function ClarifyPicker({
  question,
  options,
  onAnswer,
}: {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}) {
  // If the user picks "Something else…", we switch to a free-text input.
  const [custom, setCustom] = useState<string | null>(null);

  // Grab terminal width for the rule length. Falls back to 80 on non-TTY.
  const { stdout } = useStdout();
  const width = Math.max(20, (stdout?.columns ?? 80) - 1);
  const rule = '─'.repeat(width);

  const header = (
    <Box marginTop={1}>
      <Text color={theme.accent} bold>
        ?{' '}
      </Text>
      <Text color={theme.assistant}>{question}</Text>
    </Box>
  );

  // Free-text path (either no options provided, or user chose custom)
  if (!options?.length || custom !== null) {
    return (
      <Box flexDirection='column'>
        {header}
        <Box flexDirection='column' marginTop={1}>
          <Text color={theme.mute}>{rule}</Text>
          <Box>
            <Text color={theme.accent} bold>
              ›{' '}
            </Text>
            <TextInput
              value={custom ?? ''}
              onChange={(v) => setCustom(v)}
              onSubmit={(v) => onAnswer(v)}
              placeholder='your answer...'
            />
          </Box>
          <Text color={theme.mute}>{rule}</Text>
        </Box>
      </Box>
    );
  }

  const items = [
    ...options.map((o) => ({ label: o, value: o })),
    { label: 'Something else…', value: '__custom__' },
  ];

  return (
    <Box flexDirection='column'>
      {header}
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(i) =>
            i.value === '__custom__' ? setCustom('') : onAnswer(i.value)
          }
        />
      </Box>
    </Box>
  );
}
