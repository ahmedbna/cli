import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

export function ClarifyPicker(props: {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}) {
  const [custom, setCustom] = React.useState<string | null>(null);

  if (custom !== null) {
    return (
      <Box
        borderStyle='round'
        borderColor={theme.accent}
        flexDirection='column'
        paddingX={1}
        marginLeft={2}
      >
        <Text color={theme.accent}>? {props.question}</Text>
        <Box>
          <Text color={theme.mute}>› </Text>
          <TextInput
            value={custom}
            onChange={setCustom}
            onSubmit={(v) => props.onAnswer(v)}
          />
        </Box>
      </Box>
    );
  }

  if (!props.options?.length) {
    return (
      <Box
        borderStyle='round'
        borderColor={theme.accent}
        flexDirection='column'
        paddingX={1}
        marginLeft={2}
      >
        <Text color={theme.accent}>? {props.question}</Text>
        <Box>
          <Text color={theme.mute}>› </Text>
          <TextInput value='' onChange={() => {}} onSubmit={props.onAnswer} />
        </Box>
      </Box>
    );
  }

  const items = [
    ...props.options.map((o) => ({ label: o, value: o })),
    { label: 'Something else…', value: '__custom__' },
  ];

  return (
    <Box
      borderStyle='round'
      borderColor={theme.accent}
      flexDirection='column'
      paddingX={1}
      marginLeft={2}
    >
      <Text color={theme.accent}>? {props.question}</Text>
      <SelectInput
        items={items}
        onSelect={(i) =>
          i.value === '__custom__' ? setCustom('') : props.onAnswer(i.value)
        }
      />
    </Box>
  );
}
