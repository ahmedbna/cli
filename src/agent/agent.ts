// src/agent/agent.ts
// Core agentic loop: BNA server proxy (streaming) → tool execution → feed results back
//
// Uses /api/cli-chat which streams Anthropic SSE events directly.
// The CLI reads the stream, accumulates content, executes tools, and loops.

import { buildSystemPrompt } from './prompts.js';
import { toolDefinitions, executeTool, type ToolName } from './tools.js';
import { log } from '../utils/logger.js';
import { getAuthToken } from '../utils/store.js';
import chalk from 'chalk';
import ora from 'ora';

const MAX_ROUNDS = 30;
const API_BASE = 'https://ai.ahmedbna.com';

export interface AgentOptions {
  projectRoot: string;
  prompt: string;
  stack: 'expo' | 'expo-convex';
  onCreditsUsed?: (input: number, output: number) => Promise<void>;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ─── Anthropic SSE event types ───────────────────────────────────────────────

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
  message: {
    usage: { input_tokens: number; output_tokens: number };
  };
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

// ─── Block tracking during streaming ────────────────────────────────────────

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  inputJson: string; // accumulated partial JSON
  input: Record<string, any>;
}

type StreamBlock = TextBlock | ToolUseBlock;

// ─── Main agent loop ─────────────────────────────────────────────────────────

export async function runAgent(options: AgentOptions): Promise<void> {
  const { projectRoot, prompt, stack } = options;

  let authToken: string;
  try {
    authToken = getAuthToken();
  } catch {
    log.error('Not authenticated. Run `bna login` first.');
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt(stack);

  const accumulated: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const messages: Array<{ role: string; content: any }> = [
    {
      role: 'user',
      content:
        `Create a full-stack mobile application with the following description:\n\n${prompt}\n\n` +
        `The project root is: ${projectRoot}\n` +
        `Stack: ${stack === 'expo-convex' ? 'Expo + Convex (full-stack)' : 'Expo only'}\n\n` +
        `Please build all the necessary files and set up the project. ` +
        `Start by planning the architecture, then create the theme, UI components, ` +
        `schema, backend functions, and screens. ` +
        `After writing all files, run the necessary setup commands.`,
    },
  ];

  log.divider();
  log.info(chalk.bold('Starting BNA Agent...'));
  log.info(`Stack: ${chalk.cyan(stack)}`);
  log.info(`Project: ${chalk.cyan(projectRoot)}`);
  log.info(chalk.dim('Using BNA code'));
  log.divider();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // ── Call the streaming endpoint ────────────────────────────────────────
    let response: Response;
    try {
      response = await fetchStream(
        authToken,
        systemPrompt,
        messages,
        toolDefinitions,
      );
    } catch (err: any) {
      log.error(err.message ?? 'Network error');
      process.exit(1);
    }

    if (!response.ok) {
      let errMsg = `API request failed (${response.status})`;
      try {
        const errJson = await response.json();
        errMsg = errJson.error ?? errMsg;
      } catch {
        const errText = await response.text().catch(() => '');
        if (errText) errMsg = errText;
      }

      if (response.status === 401) {
        log.error(
          'Authentication expired. Run `bna login` to re-authenticate.',
        );
      } else if (response.status === 402) {
        log.error(
          'Insufficient credits. Visit https://ai.ahmedbna.com/credits to purchase more.',
        );
      } else if (response.status === 429) {
        log.error('Rate limited. Please wait a moment and try again.');
      } else {
        log.error(errMsg);
      }
      process.exit(1);
    }

    // ── Read and process the SSE stream ───────────────────────────────────
    const { blocks, stopReason, usage } = await readStream(response, round);

    // Accumulate token usage
    if (usage) {
      accumulated.inputTokens += usage.inputTokens;
      accumulated.outputTokens += usage.outputTokens;
    }

    // ── Build assistant message and collect tool results ──────────────────
    const assistantContent: any[] = [];
    const toolResults: any[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        assistantContent.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });

        // Execute the tool
        const toolName = block.name as ToolName;
        log.info(
          chalk.dim('Tool: ') +
            chalk.cyan(toolName) +
            (toolName === 'createFile'
              ? chalk.dim(` → ${block.input.filePath}`)
              : toolName === 'runCommand'
                ? chalk.dim(` → ${block.input.command}`)
                : ''),
        );

        let result: string;
        try {
          result = executeTool(projectRoot, toolName, block.input);
        } catch (err: any) {
          result = `Error: ${err.message}`;
          log.error(err.message);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    // Add assistant turn
    messages.push({ role: 'assistant', content: assistantContent });

    // If tools were called, add results and continue
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // No tool calls — check stop reason
    if (stopReason === 'end_turn') break;

    if (stopReason === 'max_tokens') {
      log.warn('Response truncated — continuing...');
      messages.push({
        role: 'user',
        content: 'Please continue where you left off.',
      });
      continue;
    }

    break;
  }

  // ── Report usage ──────────────────────────────────────────────────────────
  console.log();
  log.divider();
  log.info(
    chalk.dim('Tokens used: ') +
      chalk.white(`${accumulated.inputTokens.toLocaleString()} input`) +
      chalk.dim(' + ') +
      chalk.white(`${accumulated.outputTokens.toLocaleString()} output`),
  );

  if (options.onCreditsUsed) {
    await options.onCreditsUsed(
      accumulated.inputTokens,
      accumulated.outputTokens,
    );
  }

  log.success(chalk.bold('Generation complete!'));
  console.log();
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchStream(
  authToken: string,
  systemPrompt: string,
  messages: any[],
  tools: any[],
): Promise<Response> {
  const resp = await fetch(`${API_BASE}/api/cli-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ system: systemPrompt, messages, tools }),
  });
  return resp;
}

// ─── SSE stream reader ───────────────────────────────────────────────────────

interface StreamResult {
  blocks: StreamBlock[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

async function readStream(
  response: Response,
  round: number,
): Promise<StreamResult> {
  const blocks: StreamBlock[] = [];
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  // Map from block index → block in `blocks` array
  const indexToBlock = new Map<number, StreamBlock>();

  // Track if we've printed a newline after the spinner
  let textStarted = false;

  const spinner = ora({
    text: chalk.dim(`Thinking... (round ${round + 1})`),
    color: 'yellow',
  }).start();

  const body = response.body;
  if (!body) {
    spinner.stop();
    return { blocks, stopReason, usage: null };
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();

  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process all complete SSE messages in the buffer
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ':') continue; // ping / empty

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') continue;

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
                  console.log(); // blank line before text
                }
                process.stdout.write(chalk.white(text));
              }
            },
            onStopReason: (reason) => {
              stopReason = reason;
            },
            onUsage: (input, output) => {
              inputTokens += input;
              outputTokens += output;
            },
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (!textStarted) {
      spinner.stop();
    } else {
      // End the streamed text with a newline
      console.log();
    }
  }

  return {
    blocks,
    stopReason,
    usage: { inputTokens, outputTokens },
  };
}

// ─── SSE event processor ─────────────────────────────────────────────────────

function processEvent(
  event: SSEEvent,
  ctx: {
    blocks: StreamBlock[];
    indexToBlock: Map<number, StreamBlock>;
    onText: (text: string) => void;
    onStopReason: (reason: string) => void;
    onUsage: (input: number, output: number) => void;
  },
) {
  const { blocks, indexToBlock, onText, onStopReason, onUsage } = ctx;

  switch (event.type) {
    case 'message_start': {
      const u = event.message.usage;
      onUsage(u.input_tokens, u.output_tokens);
      break;
    }

    case 'content_block_start': {
      const cb = event.content_block;
      let block: StreamBlock;
      if (cb.type === 'text') {
        block = { type: 'text', text: cb.text ?? '' };
      } else {
        // tool_use
        block = {
          type: 'tool_use',
          id: cb.id,
          name: cb.name,
          inputJson: '',
          input: {},
        };
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
      onUsage(0, event.usage?.output_tokens ?? 0);
      if (event.delta.stop_reason) {
        onStopReason(event.delta.stop_reason);
      }
      break;
    }

    case 'error': {
      log.error(`Anthropic stream error: ${event.error.message}`);
      break;
    }

    default:
      break;
  }
}
