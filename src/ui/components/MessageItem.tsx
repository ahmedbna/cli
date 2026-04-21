import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { UiEvent } from '../events.js';
import { ToolCard } from './ToolCard.js';
import { SpinnerLine } from './SpinnerLine.js';

export type ChatItem =
  | { kind: 'user'; text: string; ts: number }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      streaming: boolean;
      stats?: {
        tokens?: number;
        round?: number;
        maxRounds?: number;
        elapsedMs?: number;
        verb?: string;
      };
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: any;
      state: 'running' | 'done' | 'error';
      resultPreview?: string;
      diff?: { added: number; removed: number };
    }
  | {
      kind: 'system';
      level: 'info' | 'warn' | 'error' | 'success';
      text: string;
    }
  | {
      kind: 'clarify';
      id: string;
      question: string;
      options?: string[];
      pending: boolean;
    };

export function MessageItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <UserMessage item={item} />;
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'system':
      return <SystemLine item={item} />;
    case 'clarify':
      return null; // handled by ClarifyPicker
  }
}

function UserMessage({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return (
    <Box flexDirection='column' marginTop={1}>
      <Text>
        <Text color={theme.userFg} bold>
          you
        </Text>
        <Text color={theme.mute}> · {fmtTime(item.ts)}</Text>
      </Text>
      <Box paddingLeft={2}>
        <Text color={theme.mute}>│ </Text>
        <Text>{item.text}</Text>
      </Box>
    </Box>
  );
}

function AssistantMessage({
  item,
}: {
  item: Extract<ChatItem, { kind: 'assistant' }>;
}) {
  return (
    <Box flexDirection='column' marginTop={1}>
      <Text>
        <Text color={theme.accent} bold>
          bna
        </Text>
        <Text color={theme.mute}> · streaming</Text>
      </Text>
      <Box paddingLeft={2} flexDirection='column'>
        {item.text.split('\n').map((l, i) => (
          <Text key={i}>
            <Text color={theme.mute}>│ </Text>
            {l}
          </Text>
        ))}
        {item.streaming && <SpinnerLine stats={item.stats} />}
      </Box>
    </Box>
  );
}
