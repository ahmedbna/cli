import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme } from '../theme.js';

export function ToolCard({
  item,
}: {
  item: {
    name: string;
    input: any;
    state: 'running' | 'done' | 'error';
    diff?: { added: number; removed: number };
    resultPreview?: string;
  };
}) {
  const title = formatToolTitle(item.name, item.input);
  const right =
    item.state === 'running' ? (
      <>
        <Spinner type='dots' /> <Text color={theme.mute}>running</Text>
      </>
    ) : item.diff ? (
      <Text color={theme.mute}>
        <Text color={theme.ok}>+{item.diff.added}</Text>
        {' / '}
        <Text color={theme.err}>-{item.diff.removed}</Text>
      </Text>
    ) : (
      <Text color={item.state === 'error' ? theme.err : theme.ok}>
        {item.state === 'error' ? 'failed' : 'done'}
      </Text>
    );

  return (
    <Box
      flexDirection='column'
      borderStyle='round'
      borderColor={item.state === 'error' ? theme.err : theme.border}
      paddingX={1}
      marginLeft={2}
      marginY={0}
    >
      <Box justifyContent='space-between'>
        <Text>
          <Text color={theme.mute}>tool · </Text>
          <Text color={theme.accent}>{item.name}</Text>
          <Text color={theme.mute}> · {title}</Text>
        </Text>
        <Text>{right}</Text>
      </Box>
      {item.resultPreview && (
        <Box flexDirection='column' paddingTop={0}>
          {clip(item.resultPreview, 6)
            .split('\n')
            .map((l, i) => (
              <Text key={i} color={theme.mute} dimColor>
                {l}
              </Text>
            ))}
        </Box>
      )}
    </Box>
  );
}

function formatToolTitle(name: string, input: any): string {
  if (name === 'editFile' || name === 'viewFile') return input?.filePath ?? '';
  if (name === 'shell') return input?.command ?? '';
  if (name === 'lookupDocs') return input?.skill ?? '';
  return '';
}

function clip(s: string, lines: number): string {
  const arr = s.split('\n');
  if (arr.length <= lines) return s;
  return (
    arr.slice(0, lines).join('\n') + '\n  … ' + (arr.length - lines) + ' more'
  );
}
