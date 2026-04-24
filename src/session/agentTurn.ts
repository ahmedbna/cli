// src/session/agentTurn.ts
//
// A single agent turn: model generates, tools execute, model continues
// until it stops (end_turn) OR it calls `askUser` OR the user interrupts.
//
// UI integration:
//   - When `isUiActive()`, all visible output goes through the UI event bus
//     (src/ui/events.ts) — no direct stdout writes, no spinner.
//   - When not active (non-TTY / legacy path), we fall back to the original
//     stdout streaming + liveSpinner "Thinking..." behavior.
//
// Every turn has its own spend cap (MAX_ROUNDS_PER_TURN) so a single
// user request can't run away.

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { log } from '../utils/logger.js';
import { refreshAuthToken } from '../utils/auth.js';
import { CONVEX_SITE_URL } from '../utils/store.js';
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

// ─── SSE event types (unchanged) ───────────────────────────────────────────

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
    const bootstrap =
      `You are BNA, building a mobile app from the user's description:\n\n${userMessage}\n\n` +
      `The project root is: ${session.projectRoot}\n` +
      `Stack: ${stackLabel(session.stack)}\n\n`;
    session.context.setInitialMessage(bootstrap);
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
        session,
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
          CONVEX_SITE_URL,
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

    // ── Process the blocks ────────────────────────────────────────────
    const assistantContent: any[] = [];
    const toolResults: any[] = [];
    let askUserCall: { question: string; options?: string[] } | null = null;
    let finishCall: { summary: string } | null = null;

    for (const block of blocks) {
      if (block.type === 'text') {
        assistantContent.push({ type: 'text', text: block.text });
        continue;
      }

      // tool_use
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
      if (isUiActive()) {
        emit({ type: 'warn', text: 'Response truncated — continuing...' });
      } else {
        log.warn('Response truncated — continuing...');
      }
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

// ─── HTTP helpers (unchanged) ──────────────────────────────────────────────

async function fetchStream(
  siteUrl: string,
  authToken: string,
  systemPrompt: string,
  messages: any[],
  tools: any[],
): Promise<Response> {
  return fetch(`${siteUrl}/cli/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ system: systemPrompt, messages, tools }),
  });
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_FETCH_RETRIES = 3;

async function fetchStreamWithRetry(
  authToken: string,
  systemPrompt: string,
  messages: any[],
  tools: any[],
  session: Session,
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
    if (session.isInterruptRequested()) {
      if (lastResponse) return lastResponse;
      throw new Error('interrupted');
    }

    const response = await fetchStream(
      CONVEX_SITE_URL,
      authToken,
      systemPrompt,
      messages,
      tools,
    );

    if (!RETRYABLE_STATUSES.has(response.status)) return response;
    lastResponse = response;

    try {
      await response.text();
    } catch {
      /* noop */
    }

    if (attempt < MAX_FETCH_RETRIES - 1) {
      const delay = 1000 * Math.pow(2, attempt);
      const msg = `Backend returned ${response.status} — retrying in ${delay / 1000}s (attempt ${attempt + 2}/${MAX_FETCH_RETRIES})...`;
      if (isUiActive()) emit({ type: 'warn', text: msg });
      else log.warn(msg);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return lastResponse!;
}

async function extractErrorMessage(response: Response): Promise<string> {
  const status = response.status;
  const statusText = response.statusText || '';

  if (status === 502) {
    return 'Server unavailable (502). The Convex backend is temporarily unreachable.';
  }
  if (status === 503) {
    return 'Service temporarily unavailable (503). Please try again.';
  }
  if (status === 504) {
    return 'Upstream timeout (504). Please try again.';
  }
  if (status === 429) {
    return 'Rate limited (429). Please wait a few seconds and try again.';
  }

  const ct = response.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const j = await response.json();
      return (
        j.error ?? j.message ?? `API request failed (${status} ${statusText})`
      );
    }
    const text = await response.text();
    if (
      ct.includes('text/html') ||
      /<!DOCTYPE|<html/i.test(text.slice(0, 100))
    ) {
      return `API request failed (${status} ${statusText || 'error'}).`;
    }
    const preview = text.trim().slice(0, 300);
    return `API request failed (${status}): ${preview}${text.length > 300 ? '...' : ''}`;
  } catch {
    return `API request failed (${status} ${statusText})`;
  }
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

  // Thinking indicator:
  //   - UI mode: emit 'thinking-start' (component owns the animation)
  //   - Legacy: fall back to the blocking liveSpinner
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

  // Ensure we cleanly finalize any streaming assistant message
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
                // Stop the thinking indicator at the first byte of text
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
              // If we had been streaming assistant text, seal it off here —
              // the tool run interrupts the text.
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
    if (!textStarted) {
      stopThinking();
    } else if (!uiMode) {
      process.stdout.write('\n');
    } else {
      // In UI mode the thinking indicator may still be up if only tools ran.
      // Stop it on the reader's exit; agentTurn will restart it for round 2.
      stopThinking();
    }
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
      if (isUiActive()) emit({ type: 'error', text: `Stream: ${event.error.message}` });
      else log.error(`Stream error: ${event.error.message}`);
      break;
    }
    default:
      break;
  }
}
