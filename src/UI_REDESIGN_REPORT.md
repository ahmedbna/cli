# BNA CLI — Chat UI/UX Redesign Spec

A reference design for rebuilding the BNA REPL into a Claude-Code-style (but nicer) chat experience, focused on the three areas you picked:

1. Input prompt box
2. Message rendering (user / assistant / tool-call / system)
3. Thinking / spinner UX

The approach: full rewrite of the chat surface using **Ink** (React for the terminal), keeping your existing session/agent/tooling layers untouched. Everything below is reference material — drop it into the codebase yourself when you're ready.

---

## 1. Problems with the current surface

A quick teardown of what's limiting the current `repl.ts` + `liveSpinner.ts` + `logger.ts` UI:

- **The prompt is just two horizontal rules around `❯ `**. No visual affordance that it's an input field; no placeholder; no persistent status.
- **Streaming output is `process.stdout.write(chalk.white(text))`** — the assistant text is indistinguishable from tool output, log lines, and user echo.
- **Tool calls have no visual container**. When `onToolStart` fires, the spinner just stops and the next tool call's JSON/args scroll past as plain text.
- **Inquirer owns stdin during `clarify`**, which makes it impossible to keep a persistent footer/status bar visible during questions.
- **The spinner is a single line** (`⠏ Thinking… (round 3)`). No elapsed time, no round/token counters, no rotating verbs, no tips.
- **Ctrl-C hints are logged inline** after the turn ends, instead of living in a persistent status bar where the user can always see them.
- **No history scrollback awareness**: long turns push the prompt off-screen, and the user has no sticky header to anchor context.

The plain `readline` + `chalk` + `inquirer` stack can't fix most of these cleanly because they all fight for stdout. Ink fixes it by owning the render loop and giving you a component tree.

---

## 2. Target experience (ASCII mockups)

### 2a. Idle — waiting for user input

```
╭──────────────────────────────────────────────────────────────────────────╮
│  BNA · claude-opus-4-7 · expo-convex · ~/projects/moodlog                │
│  Turn 4 · 128 credits · /help for commands                               │
╰──────────────────────────────────────────────────────────────────────────╯

  you · 12:04
  │ Add a streak counter to the home screen.

  bna · 12:04
  │ I'll add a streak field to the user doc in Convex, then render it
  │ on the home screen with a flame icon. Starting now.
  │
  │ ╭─ tool · editFile ────────────────────────────── +12 / -0 ──────────╮
  │ │ convex/schema.ts                                                   │
  │ │   users: defineTable({ …, streak: v.number() })                    │
  │ ╰────────────────────────────────────────────────────────────────────╯
  │
  │ ╭─ tool · editFile ────────────────────────────── +34 / -2 ──────────╮
  │ │ app/(tabs)/index.tsx                                               │
  │ │   <Row><Flame /> <Text>{streak} day streak</Text></Row>            │
  │ ╰────────────────────────────────────────────────────────────────────╯
  │
  │ ✓ Done. 2 files changed.

╭─ Message BNA ────────────────────────────────────────────── shift+↵ new ─╮
│ ▎                                                                        │
│                                                                          │
╰──────────────────────────────────────────────────────────────────────────╯
  ? /help · ↑/↓ history · ctrl-c interrupt · ctrl-d exit
```

### 2b. Thinking — streaming in progress

```
  bna · 12:05
  │ Looking at the current home screen and the user schema…
  │ ⠙ Marinating  ·  00:07  ·  ↓ 412 tok  ·  round 2/30
  │   tip: press / anywhere to sneak in a side question
```

The spinner row lives **inside** the assistant message, not above the prompt, so context stays readable. The verb rotates (`Marinating`, `Cooking`, `Plotting`, `Wiring`, `Polishing`) every ~6s, the elapsed timer counts monotonically, the token counter comes from the SSE `message_delta.usage`.

### 2c. Tool call in flight

```
  │ ╭─ tool · shell ───────────────────────────────────── running ⠸ ────╮
  │ │ $ npm install lucide-react-native                                 │
  │ │   added 3 packages in 4s                                         ╎│
  │ ╰───────────────────────────────────────────────────────────────────╯
```

Running tools get an inline spinner character inside the card border, so multiple in-flight tools visually stack.

### 2d. Clarify (askUser) — inline question card

```
  │ ╭─ ? Which icon library do you prefer? ──────────────────────────────╮
  │ │   ▸ lucide-react-native                                            │
  │ │     @expo/vector-icons                                             │
  │ │     Something else…                                                │
  │ ╰────────────────────────────────────────────────────────────────────╯
```

Arrow-key select, Enter confirms. No `inquirer` — render it with Ink state directly so the footer/status stays visible.

### 2e. Error

```
  │ ╭─ ⚠ Network error ──────────────────────────────────────────────────╮
  │ │ Upstream timeout (504). Retrying in 2s…                            │
  │ ╰────────────────────────────────────────────────────────────────────╯
```

### 2f. Slash-command palette

Typing `/` opens a dropdown above the input box:

```
╭─ Message BNA ────────────────────────────────────────────────────────────╮
│ /                                                                        │
╰──────────────────────────────────────────────────────────────────────────╯
╭─ commands ───────────────────────────────────────────────────────────────╮
│ ▸ /help       show commands                                              │
│   /status     project, stack, turn count                                 │
│   /history    last 20 file operations                                    │
│   /undo       revert last change                                         │
│   /modify     guide a modification                                       │
│   /continue   pick up from where agent left off                          │
│   /finalize   run build + finalize                                       │
│   /exit       save & quit                                                │
╰──────────────────────────────────────────────────────────────────────────╯
```

Fuzzy-filtered as the user types.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  repl.ts  (entry)                                        │
│    render(<App session={session} />, { exitOnCtrlC:false })│
└─────────────┬────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────┐           ┌───────────────────────┐
│   <App />              │           │  ui/events.ts         │
│   ──────────           │  <───────▶│  EventEmitter         │
│   useUiStore()         │  events   │  'msg', 'toolStart',  │
│   renders message list │           │  'toolEnd', 'stream', │
│   + input              │           │  'spinner', 'op'      │
└────────┬───────────────┘           └───────────▲───────────┘
         │                                       │ emits
         │ user submits                          │
         ▼                                       │
┌────────────────────────┐           ┌───────────┴───────────┐
│  runAgentTurn(session) │  ────────▶│  agentTurn.ts         │
│  (unchanged API)       │           │  (modified: emits     │
│                        │           │   via events instead  │
│                        │           │   of stdout.write)    │
└────────────────────────┘           └───────────────────────┘
```

**Key idea:** instead of `agentTurn.ts` writing to `process.stdout` directly, it emits events on a singleton `EventEmitter`. Ink components subscribe and re-render. The existing session/tool/planner logic is unchanged.

### 3a. Event contract

```ts
// src/ui/events.ts
import { EventEmitter } from 'node:events';

export type UiEvent =
  | { type: 'user'; text: string; ts: number }
  | { type: 'assistant-start'; id: string; ts: number }
  | { type: 'assistant-delta'; id: string; text: string }
  | { type: 'assistant-end'; id: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-end';   id: string; resultPreview: string; ok: boolean;
                          diff?: { added: number; removed: number } }
  | { type: 'spinner';    label?: string; tokens?: number; round?: number;
                          maxRounds?: number; elapsedMs?: number }
  | { type: 'spinner-stop' }
  | { type: 'op';   kind: 'create'|'update'|'delete'|'rename'; path: string }
  | { type: 'info'  | 'warn' | 'error' | 'success'; text: string }
  | { type: 'clarify'; id: string; question: string; options?: string[] }
  | { type: 'clarify-answer'; id: string; answer: string }
  | { type: 'turn-complete'; summary?: string };

export const uiBus = new EventEmitter();
export const emit = (e: UiEvent) => uiBus.emit('ui', e);
export const on   = (fn: (e: UiEvent) => void) => {
  uiBus.on('ui', fn);
  return () => uiBus.off('ui', fn);
};
```

---

## 4. Reference code (drop-in components)

All paths are under `src/ui/`. These are starting points — they compile with `react@18` + `ink@5` + `ink-text-input@6` + `ink-select-input@6`. The imports use `.js` extensions to match the codebase's existing ESM style.

### 4a. `src/ui/theme.ts`

```ts
// Color palette tuned for both dark and light terminals.
// Accent is the BNA yellow (#FAD40B) from the existing logger.
export const theme = {
  accent:    '#FAD40B',
  accentDim: '#b89a00',
  ok:        '#22c55e',
  warn:      '#f59e0b',
  err:       '#ef4444',
  info:      '#a5b4fc',
  userFg:    '#93c5fd',
  assistFg:  '#fde68a',
  mute:      '#6b7280',
  border:    '#3f3f46',
  borderHot: '#FAD40B',
  toolBg:    '#1f2937',
} as const;

export const verbs = ['Marinating', 'Cooking', 'Plotting', 'Wiring', 'Polishing'];
```

### 4b. `src/ui/components/Banner.tsx`

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function Banner(props: {
  model: string; stack: string; cwd: string;
  turn: number; credits?: number;
}) {
  const { model, stack, cwd, turn, credits } = props;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.borderHot}
      paddingX={1}
      flexDirection="column"
    >
      <Text>
        <Text bold color={theme.accent}>BNA</Text>
        <Text color={theme.mute}> · </Text>{model}
        <Text color={theme.mute}> · </Text>{stack}
        <Text color={theme.mute}> · </Text>{cwd}
      </Text>
      <Text color={theme.mute}>
        Turn {turn}{credits != null ? ` · ${credits} credits` : ''} · /help for commands
      </Text>
    </Box>
  );
}
```

### 4c. `src/ui/components/MessageItem.tsx`

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { UiEvent } from '../events.js';

export type ChatItem =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean;
      stats?: { tokens?: number; round?: number; maxRounds?: number;
                elapsedMs?: number; verb?: string } }
  | { kind: 'tool';   id: string; name: string; input: any;
      state: 'running' | 'done' | 'error';
      resultPreview?: string;
      diff?: { added: number; removed: number } }
  | { kind: 'system'; level: 'info'|'warn'|'error'|'success'; text: string }
  | { kind: 'clarify'; id: string; question: string; options?: string[];
      pending: boolean };

export function MessageItem({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':      return <UserMessage item={item} />;
    case 'assistant': return <AssistantMessage item={item} />;
    case 'tool':      return <ToolCard item={item} />;
    case 'system':    return <SystemLine item={item} />;
    case 'clarify':   return null; // handled by ClarifyPicker
  }
}

function UserMessage({ item }: { item: Extract<ChatItem,{kind:'user'}> }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.userFg} bold>you</Text>
        <Text color={theme.mute}> · {fmtTime(item.ts)}</Text>
      </Text>
      <Box paddingLeft={2}>
        <Text color={theme.mute}>│ </Text>
        <Text>{item.text}</Text>
      </Box>
    </Box>
  );
}

function AssistantMessage({ item }: { item: Extract<ChatItem,{kind:'assistant'}> }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent} bold>bna</Text>
        <Text color={theme.mute}> · streaming</Text>
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {item.text.split('\n').map((l, i) => (
          <Text key={i}><Text color={theme.mute}>│ </Text>{l}</Text>
        ))}
        {item.streaming && <SpinnerLine stats={item.stats} />}
      </Box>
    </Box>
  );
}
```

### 4d. `src/ui/components/ToolCard.tsx`

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme } from '../theme.js';

export function ToolCard({ item }: { item: {
  name: string; input: any; state: 'running'|'done'|'error';
  diff?: { added: number; removed: number }; resultPreview?: string;
} }) {
  const title = formatToolTitle(item.name, item.input);
  const right = item.state === 'running'
    ? <><Spinner type="dots" /> <Text color={theme.mute}>running</Text></>
    : item.diff
      ? <Text color={theme.mute}>
          <Text color={theme.ok}>+{item.diff.added}</Text>
          {' / '}
          <Text color={theme.err}>-{item.diff.removed}</Text>
        </Text>
      : <Text color={item.state === 'error' ? theme.err : theme.ok}>
          {item.state === 'error' ? 'failed' : 'done'}
        </Text>;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={item.state === 'error' ? theme.err : theme.border}
      paddingX={1}
      marginLeft={2}
      marginY={0}
    >
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.mute}>tool · </Text>
          <Text color={theme.accent}>{item.name}</Text>
          <Text color={theme.mute}> · {title}</Text>
        </Text>
        <Text>{right}</Text>
      </Box>
      {item.resultPreview && (
        <Box flexDirection="column" paddingTop={0}>
          {clip(item.resultPreview, 6).split('\n').map((l, i) => (
            <Text key={i} color={theme.mute} dimColor>{l}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function formatToolTitle(name: string, input: any): string {
  if (name === 'editFile' || name === 'viewFile') return input?.filePath ?? '';
  if (name === 'shell')                           return input?.command ?? '';
  if (name === 'lookupDocs')                      return input?.skill ?? '';
  return '';
}

function clip(s: string, lines: number): string {
  const arr = s.split('\n');
  if (arr.length <= lines) return s;
  return arr.slice(0, lines).join('\n') + '\n  … ' + (arr.length - lines) + ' more';
}
```

### 4e. `src/ui/components/SpinnerLine.tsx`

```tsx
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { theme, verbs } from '../theme.js';

const TIPS = [
  'press / anywhere to open the command palette',
  'ctrl-c once interrupts, twice exits',
  '/undo reverts the last file op',
  'shift+↵ inserts a newline in the input',
];

export function SpinnerLine(props: {
  stats?: { tokens?: number; round?: number; maxRounds?: number;
            elapsedMs?: number; verb?: string };
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const verb = props.stats?.verb
    ?? verbs[Math.floor(tick / 6) % verbs.length];
  const tip = TIPS[Math.floor(tick / 8) % TIPS.length];
  const elapsed = props.stats?.elapsedMs != null
    ? fmtDuration(props.stats.elapsedMs)
    : fmtDuration(tick * 1000);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.mute}>│ </Text>
        <Text color={theme.accent}><Spinner type="dots" /></Text>
        <Text> {verb}  </Text>
        <Text color={theme.mute}>·  {elapsed}</Text>
        {props.stats?.tokens != null && (
          <Text color={theme.mute}>  ·  ↓ {props.stats.tokens} tok</Text>
        )}
        {props.stats?.round != null && (
          <Text color={theme.mute}>
            {'  ·  round '}{props.stats.round}
            {props.stats.maxRounds ? `/${props.stats.maxRounds}` : ''}
          </Text>
        )}
      </Text>
      <Text>
        <Text color={theme.mute}>│   tip: {tip}</Text>
      </Text>
    </Box>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}
```

### 4f. `src/ui/components/InputBox.tsx`

```tsx
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
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={props.disabled ? theme.border : theme.borderHot}
        paddingX={1}
      >
        <Text color={theme.mute}>›&nbsp;</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={v => { if (!props.disabled) { props.onSubmit(v); setValue(''); } }}
          placeholder={props.placeholder ?? 'Message BNA…  (/ for commands)'}
        />
      </Box>
      <Text color={theme.mute}>
        {props.hint ?? '? /help · ↑/↓ history · ctrl-c interrupt · ctrl-d exit'}
      </Text>
    </Box>
  );
}
```

### 4g. `src/ui/components/SlashPalette.tsx`

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { theme } from '../theme.js';

const COMMANDS = [
  { label: '/help      show commands',                          value: '/help'     },
  { label: '/status    project, stack, turn count',             value: '/status'   },
  { label: '/history   last 20 file operations',                value: '/history'  },
  { label: '/undo      revert last change',                     value: '/undo'     },
  { label: '/modify    guide a modification',                   value: '/modify'   },
  { label: '/continue  pick up from where agent left off',      value: '/continue' },
  { label: '/finalize  run build + finalize',                   value: '/finalize' },
  { label: '/clear     clear the screen',                       value: '/clear'    },
  { label: '/exit      save & quit',                            value: '/exit'     },
];

export function SlashPalette(props: {
  filter: string;
  onSelect: (cmd: string) => void;
}) {
  const items = COMMANDS.filter(c =>
    c.value.slice(1).toLowerCase().startsWith(props.filter.toLowerCase())
  );
  if (items.length === 0) return null;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border}
      flexDirection="column"
      paddingX={1}
    >
      <Text color={theme.mute}>commands</Text>
      <SelectInput items={items} onSelect={i => props.onSelect(i.value)} />
    </Box>
  );
}
```

### 4h. `src/ui/components/ClarifyPicker.tsx`

```tsx
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
      <Box borderStyle="round" borderColor={theme.accent}
           flexDirection="column" paddingX={1} marginLeft={2}>
        <Text color={theme.accent}>? {props.question}</Text>
        <Box>
          <Text color={theme.mute}>› </Text>
          <TextInput value={custom} onChange={setCustom}
                     onSubmit={v => props.onAnswer(v)} />
        </Box>
      </Box>
    );
  }

  if (!props.options?.length) {
    return (
      <Box borderStyle="round" borderColor={theme.accent}
           flexDirection="column" paddingX={1} marginLeft={2}>
        <Text color={theme.accent}>? {props.question}</Text>
        <Box><Text color={theme.mute}>› </Text>
          <TextInput value="" onChange={() => {}} onSubmit={props.onAnswer} />
        </Box>
      </Box>
    );
  }

  const items = [
    ...props.options.map(o => ({ label: o, value: o })),
    { label: 'Something else…', value: '__custom__' },
  ];

  return (
    <Box borderStyle="round" borderColor={theme.accent}
         flexDirection="column" paddingX={1} marginLeft={2}>
      <Text color={theme.accent}>? {props.question}</Text>
      <SelectInput
        items={items}
        onSelect={i => i.value === '__custom__' ? setCustom('') : props.onAnswer(i.value)}
      />
    </Box>
  );
}
```

### 4i. `src/ui/components/StatusBar.tsx`

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function StatusBar(props: {
  agentRunning: boolean;
  model: string;
  stack: string;
  turn: number;
  credits?: number;
  hint?: string;
}) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text color={theme.mute}>
        {props.agentRunning
          ? <><Text color={theme.accent}>●</Text> agent running · ctrl-c to interrupt</>
          : <>{props.hint ?? 'ready'}</>}
      </Text>
      <Text color={theme.mute}>
        {props.model} · {props.stack} · turn {props.turn}
        {props.credits != null ? ` · ${props.credits}¢` : ''}
      </Text>
    </Box>
  );
}
```

### 4j. `src/ui/App.tsx`

```tsx
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Static, useApp, useInput } from 'ink';
import { Banner } from './components/Banner.js';
import { MessageItem, type ChatItem } from './components/MessageItem.js';
import { InputBox } from './components/InputBox.js';
import { StatusBar } from './components/StatusBar.js';
import { SlashPalette } from './components/SlashPalette.js';
import { ClarifyPicker } from './components/ClarifyPicker.js';
import { on, type UiEvent } from './events.js';
import type { Session } from '../session/session.js';

export function App({ session, onSubmit }: {
  session: Session;
  onSubmit: (text: string) => void;
}) {
  const [items, dispatch] = useReducer(itemsReducer, []);
  const [agentRunning, setRunning] = useState(false);
  const [pendingClarify, setClarify] = useState<null |
    { id: string; question: string; options?: string[] }>(null);
  const [draft, setDraft] = useState('');
  const app = useApp();

  useEffect(() => on(e => {
    dispatch(e);
    if (e.type === 'assistant-start') setRunning(true);
    if (e.type === 'turn-complete' || e.type === 'error') setRunning(false);
    if (e.type === 'clarify') setClarify({
      id: e.id, question: e.question, options: e.options,
    });
    if (e.type === 'clarify-answer') setClarify(null);
  }), []);

  useInput((input, key) => {
    if (key.ctrl && input === 'd' && !agentRunning) {
      session.persist();
      app.exit();
    }
  });

  const showPalette = draft.startsWith('/') && !agentRunning;

  return (
    <Box flexDirection="column">
      <Banner
        model="claude-opus-4-7"
        stack={session.stack}
        cwd={session.projectRoot}
        turn={session.getTurnCount()}
      />

      {/* Static renders each message once, so scrollback is preserved. */}
      <Static items={items}>
        {(item, i) => <MessageItem key={i} item={item} />}
      </Static>

      {pendingClarify && (
        <ClarifyPicker
          question={pendingClarify.question}
          options={pendingClarify.options}
          onAnswer={ans => onSubmit(ans)}
        />
      )}

      <Box marginTop={1}>
        {!pendingClarify && (
          <InputBox
            disabled={agentRunning}
            onSubmit={text => { onSubmit(text); setDraft(''); }}
            placeholder={agentRunning ? 'agent is thinking…' : 'Message BNA…  (/ for commands)'}
          />
        )}
      </Box>

      {showPalette && (
        <SlashPalette
          filter={draft.slice(1)}
          onSelect={cmd => onSubmit(cmd)}
        />
      )}

      <StatusBar
        agentRunning={agentRunning}
        model="claude-opus-4-7"
        stack={session.stack}
        turn={session.getTurnCount()}
      />
    </Box>
  );
}

function itemsReducer(state: ChatItem[], e: UiEvent): ChatItem[] {
  switch (e.type) {
    case 'user':
      return [...state, { kind: 'user', text: e.text, ts: e.ts }];
    case 'assistant-start':
      return [...state, { kind: 'assistant', id: e.id, text: '',
                          streaming: true }];
    case 'assistant-delta':
      return state.map(it => it.kind === 'assistant' && it.id === e.id
        ? { ...it, text: it.text + e.text } : it);
    case 'assistant-end':
      return state.map(it => it.kind === 'assistant' && it.id === e.id
        ? { ...it, streaming: false } : it);
    case 'tool-start':
      return [...state, { kind: 'tool', id: e.id, name: e.name,
                          input: e.input, state: 'running' }];
    case 'tool-end':
      return state.map(it => it.kind === 'tool' && it.id === e.id
        ? { ...it, state: e.ok ? 'done' : 'error',
                   resultPreview: e.resultPreview, diff: e.diff } : it);
    case 'spinner':
      return state.map(it =>
        it.kind === 'assistant' && it.streaming
          ? { ...it, stats: {
                tokens: e.tokens, round: e.round, maxRounds: e.maxRounds,
                elapsedMs: e.elapsedMs
              } }
          : it);
    case 'info': case 'warn': case 'error': case 'success':
      return [...state, { kind: 'system', level: e.type, text: e.text }];
    default:
      return state;
  }
}
```

---

## 5. Bridging the existing agent loop

Inside `src/session/agentTurn.ts`, the goal is to **remove every `process.stdout.write`** and replace them with `emit(...)` calls. The rest of the streaming state machine stays the same.

Two concrete hook points:

```ts
// Before: process.stdout.write(chalk.white(text))
// After:
emit({ type: 'assistant-delta', id: currentAssistantId, text });
```

```ts
// Before: const spinner = startSpinner(`Thinking... (round ${round + 1})`);
// After:
const start = Date.now();
const tick = setInterval(() => emit({
  type: 'spinner',
  elapsedMs: Date.now() - start,
  round: round + 1,
  maxRounds: MAX_ROUNDS_PER_TURN,
}), 1000);
```

When the stream emits `message_start`/`message_delta.usage.output_tokens`, pipe it into the `spinner` event's `tokens` field.

For tool calls:

```ts
const toolId = block.id;
emit({ type: 'tool-start', id: toolId, name: block.name, input: block.input });
// … run the tool …
emit({ type: 'tool-end',
       id: toolId,
       ok: !err,
       resultPreview: clipFirstLines(result, 6),
       diff: deriveDiff(toolName, block.input, result),
});
```

`logger.ts` gets the same treatment — keep its API, but route through the bus when Ink is mounted:

```ts
// src/utils/logger.ts (sketch)
import { emit, isUiActive } from '../ui/events.js';

export const log = {
  info:    (m: string) => isUiActive() ? emit({ type: 'info',    text: m }) : console.log(...),
  success: (m: string) => isUiActive() ? emit({ type: 'success', text: m }) : console.log(...),
  warn:    (m: string) => isUiActive() ? emit({ type: 'warn',    text: m }) : console.log(...),
  error:   (m: string) => isUiActive() ? emit({ type: 'error',   text: m }) : console.error(...),
  // etc.
};
```

And `liveSpinner.ts` becomes a thin shim that just emits `spinner` / `spinner-stop` events in Ink mode, while preserving the old ANSI behavior for non-TTY.

---

## 6. New `repl.ts` entry (sketch)

```ts
// src/session/repl.ts (replacement body)
import { render } from 'ink';
import React from 'react';
import { App } from '../ui/App.js';
import { setUiActive, emit } from '../ui/events.js';
import { runAgentTurn } from './agentTurn.js';
import type { Session } from './session.js';

export async function runRepl(session: Session, opts: ReplOptions = {}) {
  if (!process.stdout.isTTY) {
    // Fall back to the existing readline REPL for pipes / CI.
    return runLegacyRepl(session, opts);
  }

  setUiActive(true);

  let resolveInput: ((v: string) => void) | null = null;

  const instance = render(
    React.createElement(App, {
      session,
      onSubmit: (text: string) => { resolveInput?.(text); resolveInput = null; },
    })
  );

  const waitForInput = () => new Promise<string>(res => { resolveInput = res; });

  if (opts.initialPrompt) {
    await driveTurn(session, opts.initialPrompt);
  }
  if (opts.afterFirstTurn) await opts.afterFirstTurn();

  while (true) {
    const text = (await waitForInput()).trim();
    if (!text) continue;

    if (text.startsWith('/')) {
      const done = await handleSlashCommand(session, text);  // unchanged
      if (done) break;
      continue;
    }

    emit({ type: 'user', text, ts: Date.now() });
    await driveTurn(session, text);
    session.persist();
  }

  instance.unmount();
  await instance.waitUntilExit();
}

async function driveTurn(session: Session, text: string) {
  const assistantId = crypto.randomUUID();
  emit({ type: 'assistant-start', id: assistantId, ts: Date.now() });
  try {
    const outcome = await runAgentTurn(session, text);
    emit({ type: 'assistant-end', id: assistantId });
    if (outcome.kind === 'clarify') {
      emit({ type: 'clarify', id: assistantId, question: outcome.question,
             options: outcome.options });
    } else {
      emit({ type: 'turn-complete', summary: outcome.kind === 'complete'
             ? outcome.summary : undefined });
    }
  } catch (e: any) {
    emit({ type: 'error', text: e.message ?? 'turn failed' });
  }
}
```

---

## 7. Rollout plan

1. **Add deps:**
   ```bash
   npm i ink@^5 react@^18 ink-text-input ink-select-input ink-spinner
   npm i -D @types/react
   ```
2. **Create `src/ui/`** with the files from §4. No changes to existing files yet.
3. **Introduce `src/ui/events.ts`** and an `isUiActive` flag (default off).
4. **Patch `agentTurn.ts` and `logger.ts`** to emit events when `isUiActive` — keep legacy stdout/stdin paths as fallbacks.
5. **Rewrite `repl.ts`** per §6. Keep the previous body as `runLegacyRepl` for the non-TTY path (CI, pipes).
6. **Remove `inquirer` from `clarify`** — use `<ClarifyPicker />`. You can keep inquirer in the `/options` menu if you want to minimize churn, but it will flicker the Ink app; better to port that too.
7. **Manual smoke-test matrix:**
   - Fresh `bna build` → banner shows, first turn streams, spinner has elapsed time, tool cards render.
   - `bna continue` on a saved session → same.
   - Long turn (> 20 rounds) → info line appears, status bar stays visible.
   - Ctrl-C during streaming → shows "interrupted" system message, prompt is re-enabled.
   - Non-TTY (`bna build -p "hi" < /dev/null` or piped stdout) → legacy REPL kicks in with no crash.

---

## 8. Why this is "better than Claude Code"

- **Everything stays anchored**: the input box and status bar are persistent; scrollback never pushes them off-screen.
- **Tool cards are first-class**, not buried inline as raw JSON — you can see file paths, diffs, and shell commands at a glance.
- **Spinner carries real signal** (elapsed time, round count, token count) instead of just a verb.
- **Clarify is non-modal**: the agent can ask you something without hijacking stdin; you can still scroll back or press `/` to open the palette.
- **Slash palette is searchable** and always one keystroke away.
- **Legacy REPL fallback** means CI pipes and `--no-tty` environments don't break.

---

## 9. Open questions for you

- Do you want markdown rendering inside assistant bubbles (bold, inline code, fenced code blocks)? If yes, I'd add `marked` + a tiny Ink renderer, roughly +120 LOC.
- Should tool cards be **collapsible by default** (first 3 lines, `ctrl+o` to expand)? That matches Claude Code's "Reading 3 files, listing 3 directories… (ctrl+o to expand)" pattern.
- Do you want a session **sidebar** (recent file ops, credits, active skill) rendered to the right of the message log, or stay single-column?
- Theming: the mockups use the yellow `#FAD40B` accent already in `liveSpinner.ts`. Keep, or reserve yellow for warnings and pick a different accent?

Answers to these would shape a second iteration.
