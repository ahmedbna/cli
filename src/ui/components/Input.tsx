// src/ui/components/Input.tsx
//
// The bottom prompt with Claude-style top/bottom rules framing the input.
//
//   ─────────────────────────────────
//   › Message BNA  (/ for commands)
//   ─────────────────────────────────
//
// The rules span the terminal width and dim out to not compete with
// the yellow prompt marker.

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

export function Input({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  // Grab terminal width for the rule length. Falls back to 80 on non-TTY.
  const { stdout } = useStdout();
  const width = Math.max(20, (stdout?.columns ?? 80) - 1);
  const rule = '─'.repeat(width);

  return (
    <Box flexDirection='column' marginTop={1}>
      <Text color={theme.mute}>{rule}</Text>
      <Box>
        <Text color={disabled ? theme.mute : theme.accent} bold>
          ›{' '}
        </Text>
        {disabled ? (
          <Text color={theme.mute}>
            {placeholder ?? 'BNA is working... (press esc to interrupt)'}
          </Text>
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={placeholder ?? 'Message BNA...'}
            // placeholder={placeholder ?? 'Message BNA  (/ for commands)'}
          />
        )}
      </Box>
      <Text color={theme.mute}>{rule}</Text>
    </Box>
  );
}
