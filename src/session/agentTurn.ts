// src/session/agentTurn.ts
//
// Single-agent turn loop. Used for FOLLOW-UP turns after the initial build
// pipeline has run. The initial build itself is handled by the orchestrator
// in src/session/orchestrator.ts.
//
// Why follow-ups stay single-agent:
//   - They're typically small ("change the home screen background",
//     "add a delete button"). Splitting these across 3 phases would add
//     overhead without saving tokens.
//   - The blueprint is already settled, so we don't need an Architect.
//   - We DO inject the blueprint as additional context so the agent
//     understands the design intent without re-deriving it.

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { log } from '../utils/logger.js';
import { refreshAuthToken } from '../utils/auth.js';
import {
  fetchStream,
  fetchStreamWithRetry,
  extractErrorMessage,
} from '../utils/apiClient.js';
import {
  buildToolDefinitions,
  executeTool,
  type ToolName,
} from '../agent/tools.js';
import { startSpinner } from '../utils/liveSpinner.js';
import { askUserToolDefinition, finishToolDefinition } from './planner.js';
import type { TurnOutcome } from './planner.js';
import type { Session } from './session.js';
import { generalSystemPrompt } from '../agent/prompts.js';
import { emit, isUiActive } from '../ui/events.js';
import {
  formatScreensForAgent,
  formatContractsForAgent,
  formatTablesForAgent,
} from '../agent/blueprint.js';

const MAX_ROUNDS_PER_TURN = 30;
const LONG_TURN_THRESHOLD = 20;

function stackLabel(stack: 'expo' | 'expo-convex' | 'expo-supabase'): string {
  switch (stack) {
    case 'expo-convex':
      return 'Expo + Convex (full-stack)';
    case 'expo-supabase':
      return 'Expo + Supabase (full-stack)';
    case 'expo':
      return 'Expo only';
  }
}

// ─── SSE event types ───────────────────────────────────────────────────────

interface TextDelta {
  type: 'text_delta';
  text: string;
}
interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}
interface ContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block:
    | { type: 'text'; text: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, any>;
      };
}
interface ContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: TextDelta | InputJsonDelta;
}
interface ContentBlockStop {
  type: 'content_block_stop';
  index: number;
}
interface MessageDelta {
  type: 'message_delta';
  delta: { stop_reason: string; stop_sequence: string | null };
  usage: { output_tokens: number };
}
interface MessageStart {
  type: 'message_start';
  message: { usage: { input_tokens: number; output_tokens: number } };
}
type SSEEvent =
  | MessageStart
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageDelta
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  inputJson: string;
  input: Record<string, any>;
}
type StreamBlock = TextBlock | ToolUseBlock;

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function runAgentTurn(
  session: Session,
  userMessage: string,
  opts: { isInitialBuild?: boolean } = {},
): Promise<TurnOutcome> {
  const turnNumber = session.beginTurn();
  const systemPrompt = generalSystemPrompt({ stack: session.stack });

  if (opts.isInitialBuild && turnNumber === 1) {
    // This path is unused now (orchestrator handles initial builds), but
    // we preserve it for the legacy CI fallback path which calls runAgentTurn
    // directly.
    const bootstrap =
      `You are BNA, building a mobile app from the user's description:\n\n${userMessage}\n\n` +
      `The project root is: ${session.projectRoot}\n` +
      `Stack: ${stackLabel(session.stack)}\n\n`;
    session.context.setInitialMessage(bootstrap);
  } else if (turnNumber === 1) {
    // First follow-up turn after a resumed/orchestrator-built session.
    // Inject the blueprint so the agent understands the existing design
    // without having to read every backend/frontend file from scratch.
    const blueprintContext = buildBlueprintContext(session);
    session.context.setInitialMessage(
      `You are BNA, continuing work on an already-built mobile app.\n` +
        `The project root is: ${session.projectRoot}\n` +
        `Stack: ${stackLabel(session.stack)}\n\n` +
        blueprintContext +
        `\n\nUser request:\n${userMessage}`,
    );
  } else {
    session.context.addUserText(userMessage);
  }

  const allTools = [
    ...buildToolDefinitions(session.stack),
    askUserToolDefinition,
    finishToolDefinition,
  ];

  const toolCtx = {
    projectRoot: session.projectRoot,
    installManager: session.installManager,
    session,
  };

  for (let round = 0; round < MAX_ROUNDS_PER_TURN; round++) {
    if (session.isInterruptRequested()) {
      session.clearInterrupt();
      emit({ type: 'thinking-stop' });
      return { kind: 'interrupted' };
    }

    if (round === LONG_TURN_THRESHOLD) {
      if (isUiActive()) {
        emit({
          type: 'info',
          text: `(this turn is getting long — ${round} rounds. Press esc to interrupt.)`,
        });
      } else {
        log.info(
          chalk.dim(
            `(This turn is getting long — ${round} rounds. Press Ctrl-C to interrupt.)`,
          ),
        );
      }
    }

    let response: Response;
    try {
      response = await fetchStreamWithRetry(
        session.getAuthToken(),
        systemPrompt,
        session.context.getMessages(),
        allTools,
        { isInterrupted: () => session.isInterruptRequested() },
      );
    } catch (err: any) {
      emit({ type: 'thinking-stop' });
      return {
        kind: 'error',
        message: `Network error: ${err.message ?? 'Unknown error'}`,
      };
    }

    if (response.status === 401) {
      emit({ type: 'thinking-stop' });
      if (isUiActive())
        emit({ type: 'warn', text: 'Auth token expired, refreshing...' });
      else log.warn('Auth token expired mid-session, refreshing...');
      const refreshed = await refreshAuthToken();
      if (!refreshed) {
        return {
          kind: 'error',
          message:
            'Authentication expired. Run `bna login` to re-authenticate.',
        };
      }
      session.setAuthToken(refreshed);
      if (isUiActive())
        emit({ type: 'success', text: 'Token refreshed, retrying...' });
      else log.success('Token refreshed, retrying...');
      try {
        response = await fetchStream(
          refreshed,
          systemPrompt,
          session.context.getMessages(),
          allTools,
        );
      } catch (err: any) {
        return { kind: 'error', message: `Network error: ${err.message}` };
      }
      if (response.status === 401) {
        return {
          kind: 'error',
          message:
            'Authentication expired. Run `bna login` to re-authenticate.',
        };
      }
    }

    if (response.status === 402) {
      emit({ type: 'thinking-stop' });
      return {
        kind: 'error',
        message:
          'Insufficient credits. Visit https://ai.ahmedbna.com/credits to purchase more.',
      };
    }

    if (!response.ok) {
      emit({ type: 'thinking-stop' });
      const msg = await extractErrorMessage(response);
      return { kind: 'error', message: msg };
    }

    const { blocks, stopReason } = await readStream(response, round, session);

    const assistantContent: any[] = [];
    const toolResults: any[] = [];
    let askUserCall: { question: string; options?: string[] } | null = null;
    let finishCall: { summary: string } | null = null;

    for (const block of blocks) {
      if (block.type === 'text') {
        assistantContent.push({ type: 'text', text: block.text });
        continue;
      }

      assistantContent.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });

      if (block.name === 'askUser') {
        askUserCall = {
          question: block.input.question ?? '',
          options: block.input.options,
        };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: '(paused — waiting for user response)',
        });
        continue;
      }
      if (block.name === 'finish') {
        finishCall = { summary: block.input.summary ?? '' };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'acknowledged',
        });
        continue;
      }

      const toolName = block.name as ToolName;
      let result: string;

      if (toolName === 'viewFile' && block.input.filePath) {
        const stub = session.context.getDedupStubForView(block.input.filePath);
        if (stub) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: stub,
          });
          continue;
        }
      }

      try {
        result = await executeTool(toolCtx, toolName, block.input);
      } catch (err: any) {
        result = `Error: ${err.message}`;
        if (isUiActive()) emit({ type: 'error', text: err.message });
        else log.error(err.message);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });

      if (session.isInterruptRequested()) {
        session.context.addAssistantMessage(assistantContent);
        session.context.addToolResults(toolResults);
        session.clearInterrupt();
        emit({ type: 'thinking-stop' });
        return { kind: 'interrupted' };
      }
    }

    session.context.addAssistantMessage(assistantContent);

    if (askUserCall) {
      if (toolResults.length > 0) session.context.addToolResults(toolResults);
      emit({ type: 'thinking-stop' });
      return {
        kind: 'clarify',
        question: askUserCall.question,
        options: askUserCall.options,
      };
    }

    if (finishCall) {
      if (toolResults.length > 0) session.context.addToolResults(toolResults);
      emit({ type: 'thinking-stop' });
      return { kind: 'complete', summary: finishCall.summary };
    }

    if (toolResults.length > 0) {
      session.context.addToolResults(toolResults);
      continue;
    }

    if (stopReason === 'end_turn') {
      emit({ type: 'thinking-stop' });
      return { kind: 'complete' };
    }

    if (stopReason === 'max_tokens') {
      if (isUiActive())
        emit({ type: 'warn', text: 'Response truncated — continuing...' });
      else log.warn('Response truncated — continuing...');
      session.context.addUserText('Please continue where you left off.');
      continue;
    }

    emit({ type: 'thinking-stop' });
    return { kind: 'complete' };
  }

  emit({ type: 'thinking-stop' });
  return {
    kind: 'clarify',
    question: `I've run ${MAX_ROUNDS_PER_TURN} rounds on this request. Should I keep going, or would you like to guide me?`,
    options: ['keep going', 'stop here'],
  };
}

// ─── Blueprint context for follow-up turns ────────────────────────────────

function buildBlueprintContext(session: Session): string {
  const bp = session.getBlueprint();
  if (!bp) {
    return '(no blueprint available — this is a legacy session or fresh resume)';
  }

  const sections: string[] = [];
  sections.push("## Blueprint (the architect's plan for this app)");
  sections.push(`App: ${bp.meta.appName}`);
  sections.push(`Description: ${bp.meta.description}`);
  sections.push(
    `Theme: ${bp.theme.palette}` +
      (bp.theme.accentHint ? ` (accent: ${bp.theme.accentHint})` : '') +
      ` · tone: ${bp.theme.tone}`,
  );
  sections.push('');
  sections.push('### Screens');
  sections.push(formatScreensForAgent(bp.screens));
  if (bp.dataModel.length > 0) {
    sections.push('');
    sections.push('### Data model');
    sections.push(formatTablesForAgent(bp.dataModel));
  }
  if (bp.apiContracts.length > 0) {
    sections.push('');
    sections.push('### API contracts');
    sections.push(formatContractsForAgent(bp.apiContracts));
  }
  if (bp.architectNotes) {
    sections.push('');
    sections.push('### Architect notes');
    sections.push(bp.architectNotes);
  }
  sections.push('');
  sections.push(
    'When making changes, respect the existing architecture. ' +
      'If the user asks for a feature that requires a new API or table, ' +
      'add it incrementally — do NOT redesign the app.',
  );

  return sections.join('\n');
}

// ─── SSE stream reader ─────────────────────────────────────────────────────

interface StreamResult {
  blocks: StreamBlock[];
  stopReason: string;
}

async function readStream(
  response: Response,
  round: number,
  session: Session,
): Promise<StreamResult> {
  const blocks: StreamBlock[] = [];
  let stopReason = 'end_turn';

  const indexToBlock = new Map<number, StreamBlock>();
  let textStarted = false;
  let assistantId: string | null = null;

  const uiMode = isUiActive();
  let spinner: ReturnType<typeof startSpinner> | null = null;

  if (uiMode) {
    emit({
      type: 'thinking-start',
      round: round + 1,
      maxRounds: MAX_ROUNDS_PER_TURN,
    });
  } else {
    spinner = startSpinner(
      chalk.hex('#a5b4fc')(`Thinking... (round ${round + 1})`),
    );
  }

  const stopThinking = () => {
    if (uiMode) emit({ type: 'thinking-stop' });
    else spinner?.stop();
  };

  const endAssistant = () => {
    if (uiMode && assistantId) {
      emit({ type: 'assistant-end', id: assistantId });
      assistantId = null;
    }
  };

  const body = response.body;
  if (!body) {
    stopThinking();
    return { blocks, stopReason };
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      if (session.isInterruptRequested()) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let currentEventType: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ':') {
          currentEventType = null;
          continue;
        }

        if (trimmed.startsWith('event: ')) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') continue;

          if (
            currentEventType === 'bna_credits' ||
            currentEventType === 'bna_credits_final'
          ) {
            currentEventType = null;
            continue;
          }
          currentEventType = null;

          let event: SSEEvent;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          processEvent(event, {
            blocks,
            indexToBlock,
            onText: (text) => {
              if (!text) return;
              if (!textStarted) {
                stopThinking();
                textStarted = true;
                if (uiMode) {
                  assistantId = randomUUID();
                  emit({
                    type: 'assistant-start',
                    id: assistantId,
                    ts: Date.now(),
                  });
                } else {
                  console.log();
                }
              }
              if (uiMode && assistantId) {
                emit({ type: 'assistant-delta', id: assistantId, text });
              } else {
                process.stdout.write(chalk.white(text));
              }
            },
            onToolStart: () => {
              if (!textStarted) {
                stopThinking();
                textStarted = true;
              } else if (!uiMode) {
                process.stdout.write('\n');
              }
              endAssistant();
            },
            onStopReason: (reason) => {
              stopReason = reason;
            },
            onTokens: (n) => {
              if (uiMode) emit({ type: 'thinking-tokens', tokens: n });
            },
          });
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
    endAssistant();
    if (!textStarted) stopThinking();
    else if (!uiMode) process.stdout.write('\n');
    else stopThinking();
  }

  return { blocks, stopReason };
}

function processEvent(
  event: SSEEvent,
  ctx: {
    blocks: StreamBlock[];
    indexToBlock: Map<number, StreamBlock>;
    onText: (text: string) => void;
    onToolStart: () => void;
    onStopReason: (reason: string) => void;
    onTokens: (n: number) => void;
  },
) {
  const { blocks, indexToBlock, onText, onToolStart, onStopReason, onTokens } =
    ctx;

  switch (event.type) {
    case 'message_start': {
      const u = event.message.usage;
      onTokens(u.output_tokens);
      break;
    }
    case 'content_block_start': {
      const cb = event.content_block;
      let block: StreamBlock;
      if (cb.type === 'text') {
        block = { type: 'text', text: cb.text ?? '' };
      } else {
        block = {
          type: 'tool_use',
          id: cb.id,
          name: cb.name,
          inputJson: '',
          input: {},
        };
        onToolStart();
      }
      blocks.push(block);
      indexToBlock.set(event.index, block);
      break;
    }
    case 'content_block_delta': {
      const block = indexToBlock.get(event.index);
      if (!block) break;
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        if (block.type === 'text') {
          block.text += delta.text;
          onText(delta.text);
        }
      } else if (delta.type === 'input_json_delta') {
        if (block.type === 'tool_use') {
          block.inputJson += delta.partial_json;
        }
      }
      break;
    }
    case 'content_block_stop': {
      const block = indexToBlock.get(event.index);
      if (block?.type === 'tool_use') {
        try {
          block.input = JSON.parse(block.inputJson || '{}');
        } catch {
          block.input = {};
        }
      }
      break;
    }
    case 'message_delta': {
      if (event.delta.stop_reason) onStopReason(event.delta.stop_reason);
      if (event.usage?.output_tokens) onTokens(event.usage.output_tokens);
      break;
    }
    case 'error': {
      if (isUiActive())
        emit({ type: 'error', text: `Stream: ${event.error.message}` });
      else log.error(`Stream error: ${event.error.message}`);
      break;
    }
    default:
      break;
  }
}
