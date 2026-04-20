// src/session/agentTurn.ts
//
// A single agent turn: model generates, tools execute, model continues
// until it stops (end_turn) OR it calls `askUser` OR the user interrupts.
//
// Unlike the old monolithic runAgent, this:
//   - Takes a Session (carries all persistent state across turns)
//   - Returns a TurnOutcome (complete | clarify | interrupted | error)
//   - Respects session.isInterruptRequested() after every tool call
//   - Uses the new askUser and finish meta-tools alongside regular tools
//
// Every turn has its own spend cap (MAX_ROUNDS_PER_TURN) so a single
// user request can't run away — if the model is still going after N
// rounds, we return `clarify` and ask the user whether to keep going.

import chalk from 'chalk';
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

const MAX_ROUNDS_PER_TURN = 30;
const LONG_TURN_THRESHOLD = 20;

// ─── SSE event types (unchanged from original) ─────────────────────────────

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

// ─── Main entry: run one conversational turn ────────────────────────────────

export async function runAgentTurn(
  session: Session,
  userMessage: string,
  opts: { isInitialBuild?: boolean } = {},
): Promise<TurnOutcome> {
  const turnNumber = session.beginTurn();
  const systemPrompt = generalSystemPrompt({ stack: session.stack });

  // First turn: set the bootstrap context. Subsequent turns: append.
  if (opts.isInitialBuild && turnNumber === 1) {
    const bootstrap =
      `You are BNA, building a mobile app from the user's description:\n\n${userMessage}\n\n` +
      `The project root is: ${session.projectRoot}\n` +
      `Stack: ${session.stack === 'expo-convex' ? 'Expo + Convex (full-stack)' : 'Expo only'}\n\n`;
    session.context.setInitialMessage(bootstrap);
  } else {
    session.context.addUserText(userMessage);
  }

  // Assemble tools: regular tools (filtered to the session's stack) +
  // askUser + finish. Skill-scoped tools like lookupDocs only see the
  // skills for the selected frontend/backend techs.
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
    // ── Check for interrupt before each round ───────────────────────────
    if (session.isInterruptRequested()) {
      session.clearInterrupt();
      return { kind: 'interrupted' };
    }

    // ── Soft warning when the turn is getting long ──────────────────────
    if (round === LONG_TURN_THRESHOLD) {
      log.info(
        chalk.dim(
          `(This turn is getting long — ${round} rounds. Press Ctrl-C to interrupt.)`,
        ),
      );
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
      return {
        kind: 'error',
        message: `Network error: ${err.message ?? 'Unknown error'}`,
      };
    }

    if (response.status === 401) {
      log.warn('Auth token expired mid-session, refreshing...');
      const refreshed = await refreshAuthToken();
      if (!refreshed) {
        return {
          kind: 'error',
          message:
            'Authentication expired. Run `bna login` to re-authenticate.',
        };
      }
      session.setAuthToken(refreshed);
      log.success('Token refreshed, retrying...');
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
      return {
        kind: 'error',
        message:
          'Insufficient credits. Visit https://ai.ahmedbna.com/credits to purchase more.',
      };
    }

    if (!response.ok) {
      const msg = await extractErrorMessage(response);
      return { kind: 'error', message: msg };
    }

    const { blocks, stopReason } = await readStream(response, round, session);

    // ── Process the blocks ──────────────────────────────────────────────
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

      // Intercept meta-tools
      if (block.name === 'askUser') {
        askUserCall = {
          question: block.input.question ?? '',
          options: block.input.options,
        };
        // Synthesize an ack result so the context is balanced
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

      // Regular tool — dedup viewFile against context manager
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
        log.error(err.message);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });

      // Check for interrupt after each tool — lets the user Ctrl-C
      // mid-generation and have it honored promptly.
      if (session.isInterruptRequested()) {
        session.context.addAssistantMessage(assistantContent);
        session.context.addToolResults(toolResults);
        session.clearInterrupt();
        return { kind: 'interrupted' };
      }
    }

    session.context.addAssistantMessage(assistantContent);

    // ── Decide outcome ──────────────────────────────────────────────────

    if (askUserCall) {
      // Persist the ack tool result so history is balanced
      if (toolResults.length > 0) session.context.addToolResults(toolResults);
      return {
        kind: 'clarify',
        question: askUserCall.question,
        options: askUserCall.options,
      };
    }

    if (finishCall) {
      if (toolResults.length > 0) session.context.addToolResults(toolResults);
      return { kind: 'complete', summary: finishCall.summary };
    }

    if (toolResults.length > 0) {
      session.context.addToolResults(toolResults);
      continue;
    }

    if (stopReason === 'end_turn') {
      return { kind: 'complete' };
    }

    if (stopReason === 'max_tokens') {
      log.warn('Response truncated — continuing...');
      session.context.addUserText('Please continue where you left off.');
      continue;
    }

    return { kind: 'complete' };
  }

  // Exceeded MAX_ROUNDS_PER_TURN
  return {
    kind: 'clarify',
    question: `I've run ${MAX_ROUNDS_PER_TURN} rounds on this request. Should I keep going, or would you like to guide me?`,
    options: ['keep going', 'stop here'],
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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
    // Honor interrupts between retries
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

    // Success OR non-retryable error → return immediately so the caller
    // can handle auth/credits/etc. We only retry the gateway 5xx family.
    if (!RETRYABLE_STATUSES.has(response.status)) {
      return response;
    }

    lastResponse = response;

    // Drain the body so the connection can be reused
    try {
      await response.text();
    } catch {
      /* noop */
    }

    if (attempt < MAX_FETCH_RETRIES - 1) {
      const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      log.warn(
        `Backend returned ${response.status} — retrying in ${delay / 1000}s (attempt ${attempt + 2}/${MAX_FETCH_RETRIES})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted — return the last response so the regular
  // error path (extractErrorMessage) can format a clean message.
  return lastResponse!;
}

async function extractErrorMessage(response: Response): Promise<string> {
  const status = response.status;
  const statusText = response.statusText || '';

  // Map known gateway/infrastructure errors to clean messages — these come
  // from Cloudflare/Convex and the body is always HTML, never useful.
  if (status === 502) {
    return 'Server unavailable (502 Bad Gateway). The Convex backend is temporarily unreachable. Please try again in a moment.';
  }
  if (status === 503) {
    return 'Service temporarily unavailable (503). Please try again in a moment.';
  }
  if (status === 504) {
    return 'Upstream timeout (504). The backend took too long to respond. Please try again.';
  }
  if (status === 429) {
    return 'Rate limited (429). Please wait a few seconds and try again.';
  }

  const ct = response.headers.get('content-type') ?? '';

  try {
    // Only parse JSON bodies — HTML bodies are always error pages
    if (ct.includes('application/json')) {
      const j = await response.json();
      return (
        j.error ?? j.message ?? `API request failed (${status} ${statusText})`
      );
    }

    // For non-JSON responses (HTML error pages, plain text), don't dump the body.
    // Read a short preview and discard the rest.
    const text = await response.text();
    if (
      ct.includes('text/html') ||
      /<!DOCTYPE|<html/i.test(text.slice(0, 100))
    ) {
      return `API request failed (${status} ${statusText || 'error'}). The server returned an HTML error page — it may be down or misconfigured.`;
    }

    // Plain text error — safe to show but truncate aggressively
    const preview = text.trim().slice(0, 300);
    return `API request failed (${status}): ${preview}${text.length > 300 ? '...' : ''}`;
  } catch {
    return `API request failed (${status} ${statusText})`;
  }
}

// ─── SSE stream reader ───────────────────────────────────────────────────────

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

  const spinner = startSpinner(
    chalk.hex('#a5b4fc')(`Thinking... (round ${round + 1})`),
  );

  const body = response.body;
  if (!body) {
    spinner.stop();
    return { blocks, stopReason };
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      // Honor interrupts during streaming — release the reader and exit.
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
              if (text) {
                if (!textStarted) {
                  spinner.stop();
                  textStarted = true;
                  console.log();
                }
                process.stdout.write(chalk.white(text));
              }
            },
            onToolStart: () => {
              if (!textStarted) {
                spinner.stop();
                textStarted = true;
              } else {
                process.stdout.write('\n');
              }
            },
            onStopReason: (reason) => {
              stopReason = reason;
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
    if (!textStarted) {
      spinner.stop();
    } else {
      process.stdout.write('\n');
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
  },
) {
  const { blocks, indexToBlock, onText, onToolStart, onStopReason } = ctx;

  switch (event.type) {
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
      break;
    }
    case 'error': {
      log.error(`Stream error: ${event.error.message}`);
      break;
    }
    default:
      break;
  }
}
