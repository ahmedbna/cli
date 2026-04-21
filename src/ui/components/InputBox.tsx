import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

export function InputBox(props: {
  onSubmit: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  const [value, setValue] = useState('');
  return (
    <Box flexDirection='column'>
      <Box
        borderStyle='round'
        borderColor={props.disabled ? theme.border : theme.borderHot}
        paddingX={1}
      >
        <Text color={theme.mute}>›&nbsp;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(v) => {
            if (!props.disabled) {
              props.onSubmit(v);
              setValue('');
            }
          }}
          placeholder={props.placeholder ?? 'Message BNA…  (/ for commands)'}
        />
      </Box>
      <Text color={theme.mute}>
        {props.hint ?? '? /help · ↑/↓ history · ctrl-c interrupt · ctrl-d exit'}
      </Text>
    </Box>
  );
}
