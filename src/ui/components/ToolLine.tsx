// src/ui/components/ToolLine.tsx
//
// Compact inline tool call — one line, Claude-Code-style.
//
// Layout:
//   ● Reading convex/schema.ts
//   ⠙ Editing app/(tabs)/index.tsx
//   ● Running npx expo install lucide-react-native ✓
//       added 3 packages in 4s       ← streamed progress (optional, dim)
//
// The leading dot is:
//   ⠙  spinner frames while running (animated via ink-spinner)
//   ●  green when done
//   ●  red  when failed

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme } from '../theme.js';

export interface ToolLineItem {
  id: string;
  name: string;
  label: string;
  extra?: string;
  state: 'running' | 'done' | 'error';
  /** Last few streamed progress lines, shown dim under the tool line. */
  progress?: string[];
}

// Map tool name → human verb. Matches your existing action labels in tools.ts
// (Creating/Updating/Reading/...) but condensed for inline readability.
const VERBS: Record<string, string> = {
  createFile: 'Writing',
  editFile: 'Editing',
  deleteFile: 'Removing',
  renameFile: 'Moving',
  viewFile: 'Reading',
  readMultipleFiles: 'Reading',
  listDirectory: 'Listing',
  searchFiles: 'Searching',
  runCommand: 'Running',
  lookupDocs: 'Loading skill',
  addEnvironmentVariables: 'Queued env',
  checkDependencies: 'Checking deps',
};

export function ToolLine({ item }: { item: ToolLineItem }) {
  const verb = VERBS[item.name] ?? item.name;

  // Dot color: accent while running, green done, red failed.
  // When running we show ink-spinner frames in place of the dot for a live feel.
  const dot =
    item.state === 'running' ? (
      <Text color={theme.accent}>
        <Spinner type='dots' />
      </Text>
    ) : item.state === 'error' ? (
      <Text color={theme.err}>●</Text>
    ) : (
      <Text color={theme.ok}>●</Text>
    );

  // Trailing suffix: (12 lines), +12/-0, failed, etc.
  const suffix = (() => {
    if (item.state === 'error') {
      return (
        <Text color={theme.err}>
          {' '}
          {item.extra ? item.extra : 'failed'}
        </Text>
      );
    }
    if (item.extra) return <Text color={theme.mute}> {item.extra}</Text>;
    return null;
  })();

  // Progress: last 3 lines max, dim, indented. Keeps the scroll readable.
  const progress = (item.progress ?? []).slice(-3);

  return (
    <Box flexDirection='column'>
      <Text>
        {dot}
        <Text> </Text>
        <Text color={theme.assistant}>{verb} </Text>
        <Text color={theme.accent}>{item.label}</Text>
        {suffix}
      </Text>
      {progress.length > 0 && (
        <Box flexDirection='column'>
          {progress.map((line, i) => (
            <Text key={i} color={theme.dim}>
              {'    '}
              {truncate(line, 110)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
