// src/agent/agent.ts
//
// Core agentic loop: Convex HTTP action proxy (streaming) → tool execution → feed results back
//
// Uses /cli/chat on the Convex site URL which streams Anthropic SSE events directly.
// The CLI reads the stream, accumulates content, executes tools, and loops.
//
// Credit deduction:
//   Credits are deducted SERVER-SIDE during streaming. The server injects custom
//   SSE events (`bna_credits` and `bna_credits_final`) so the CLI can display
//   running usage. The CLI does NOT control deduction — it only displays info.
//
// Auth: uses Convex auth token passed via authToken option.
// On 401, automatically attempts token refresh and retries once.

import { generalSystemPrompt } from './prompts.js';
import { toolDefinitions, executeTool, type ToolName } from './tools.js';
import { log } from '../utils/logger.js';
import { getAuthToken, CONVEX_SITE_URL } from '../utils/store.js';
import { refreshAuthToken } from '../utils/auth.js';
import chalk from 'chalk';
import ora from 'ora';

const MAX_ROUNDS = 30;

export interface AgentOptions {
  projectRoot: string;
  prompt: string;
  stack: 'expo' | 'expo-convex';
  authToken?: string;
  onCreditsUsed?: (input: number, output: number) => Promise<void>;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ─── Credit tracking from server events ──────────────────────────────────────

interface CreditInfo {
  creditsUsed: number;
  remainingCredits: number;
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
  inputJson: string;
  input: Record<string, any>;
}

type StreamBlock = TextBlock | ToolUseBlock;

// ─── Shimmer spinner for "thinking" state ────────────────────────────────────

const SHIMMER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SHIMMER_COLORS = [
  chalk.hex('#6366f1'),
  chalk.hex('#818cf8'),
  chalk.hex('#a5b4fc'),
  chalk.hex('#c7d2fe'),
  chalk.hex('#a5b4fc'),
  chalk.hex('#818cf8'),
];

function createShimmerSpinner(text: string) {
  let colorIdx = 0;

  const spinner = ora({
    text: '',
    spinner: {
      interval: 80,
      frames: SHIMMER_CHARS,
    },
    color: 'magenta',
  });

  const interval = setInterval(() => {
    const color = SHIMMER_COLORS[colorIdx % SHIMMER_COLORS.length];
    spinner.text = color(text);
    colorIdx++;
  }, 200);

  spinner.start();

  return {
    stop: () => {
      clearInterval(interval);
      spinner.stop();
    },
    succeed: (msg?: string) => {
      clearInterval(interval);
      spinner.succeed(msg);
    },
    update: (newText: string) => {
      text = newText;
    },
  };
}

// ─── Main agent loop ─────────────────────────────────────────────────────────

export async function runAgent(options: AgentOptions): Promise<void> {
  const { projectRoot, prompt, stack } = options;

  // Use the pre-validated token if provided, otherwise read from store
  let authToken: string;
  if (options.authToken) {
    authToken = options.authToken;
  } else {
    try {
      authToken = getAuthToken();
    } catch {
      log.error('Not authenticated. Run `bna login` first.');
      process.exit(1);
    }
  }

  const systemPrompt = generalSystemPrompt({ stack });

  const accumulated: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  // Track credit info received from server events
  let latestCreditInfo: CreditInfo = { creditsUsed: 0, remainingCredits: -1 };

  const messages: Array<{ role: string; content: any }> = [
    {
      role: 'user',
      content:
        `You are BNA, an expert AI assistant and senior software engineer create app with the following description:\n\n${prompt}\n\n` +
        `The project root is: ${projectRoot}\n` +
        `Stack: ${stack === 'expo-convex' ? 'Expo + Convex (full-stack)' : 'Expo only'}\n\n` +
        `The project template has already been copied and dependencies installed. ` +
        `The template includes: app/_layout.tsx, app/(home)/_layout.tsx, app/(home)/index.tsx, ` +
        `app/(home)/settings.tsx, components/auth/, components/ui/button.tsx, components/ui/spinner.tsx, ` +
        `convex/schema.ts, convex/auth.ts, convex/users.ts, convex/http.ts, theme/colors.ts, hooks/.\n\n` +
        `DO NOT run \`npx create-expo-app\` or \`npm init\` — the project is already scaffolded.\n` +
        `DO NOT run \`npm install\` for base dependencies — they are already installed.\n` +
        `DO NOT run \`npx convex dev\` — it will be started automatically after you finish.\n\n` +
        `Your job is to customize this template to match the user's description:\n` +
        `1. Design a unique theme (colors.ts) for this specific app\n` +
        `2. Build or update UI components in components/ui/\n` +
        `3. Add tables to the Convex schema (keep ...authTables and users table)\n` +
        `4. Write Convex query/mutation functions\n` +
        `5. Build the screens\n` +
        `6. Only run \`npx expo install <pkg>\` if you need NEW packages not in the template\n` +
        `7. IMPORTANT: As your FINAL step, write an ARCHITECTURE.md file at the project root that documents the complete project structure, what each file does, and where it is used. This is critical for future modifications.`,
    },
  ];

  log.divider();
  log.info(chalk.bold('Starting BNA Agent...'));
  log.info(`Stack: ${chalk.cyan(stack)}`);
  log.info(`Project: ${chalk.cyan(projectRoot)}`);
  log.divider();

  // ── Register graceful exit handler ─────────────────────────────────────
  // If the user presses Ctrl+C, display credit usage before exiting.
  const exitHandler = () => {
    console.log();
    log.divider();
    if (latestCreditInfo.creditsUsed > 0) {
      log.info(
        chalk.dim('Credits used: ') +
          chalk.white(`${latestCreditInfo.creditsUsed}`),
      );
      if (latestCreditInfo.remainingCredits >= 0) {
        log.info(
          chalk.dim('Remaining: ') +
            chalk.white(`${latestCreditInfo.remainingCredits}`),
        );
      }
    }
    log.info(
      chalk.dim('Tokens used: ') +
        chalk.white(`${accumulated.inputTokens.toLocaleString()} input`) +
        chalk.dim(' + ') +
        chalk.white(`${accumulated.outputTokens.toLocaleString()} output`),
    );
    log.warn(
      'Agent interrupted. Credits for tokens already streamed have been deducted server-side.',
    );
    process.exit(0);
  };

  process.on('SIGINT', exitHandler);
  process.on('SIGTERM', exitHandler);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // ── Call the streaming endpoint ────────────────────────────────────────
    let response: Response;
    try {
      response = await fetchStream(
        CONVEX_SITE_URL,
        authToken,
        systemPrompt,
        messages,
        toolDefinitions,
      );
    } catch (err: any) {
      log.error(`Network error: ${err.message ?? 'Unknown error'}`);
      log.warn('Check your internet connection and try again.');
      log.warn(
        'Note: credits for any tokens already streamed have been deducted server-side.',
      );
      process.exit(1);
    }

    // ── Handle 401 with automatic token refresh + retry ───────────────────
    if (response.status === 401) {
      log.warn('Auth token expired mid-session, attempting refresh...');
      const refreshedToken = await refreshAuthToken();

      if (refreshedToken) {
        authToken = refreshedToken;
        log.success('Token refreshed, retrying...');

        try {
          response = await fetchStream(
            CONVEX_SITE_URL,
            authToken,
            systemPrompt,
            messages,
            toolDefinitions,
          );
        } catch (err: any) {
          log.error(
            `Network error after refresh: ${err.message ?? 'Unknown error'}`,
          );
          process.exit(1);
        }

        if (response.status === 401) {
          log.error(
            'Authentication expired. Run `bna login` to re-authenticate.',
          );
          process.exit(1);
        }
      } else {
        log.error(
          'Authentication expired and could not be refreshed.\n' +
            `  Run ${chalk.cyan('bna login')} to re-authenticate.`,
        );
        process.exit(1);
      }
    }

    // ── Handle 402 Payment Required (insufficient credits) ────────────────
    if (response.status === 402) {
      log.error(
        'Insufficient credits. Visit https://ai.ahmedbna.com/credits to purchase more.',
      );
      process.exit(1);
    }

    if (!response.ok) {
      let errMsg = `API request failed (${response.status})`;
      let errBody = '';

      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const errJson = await response.json();
          errBody = errJson.error ?? errJson.message ?? JSON.stringify(errJson);
        } else {
          errBody = await response.text();
        }
        if (errBody) errMsg = errBody;
      } catch {
        // ignore parse errors
      }

      if (response.status === 429) {
        log.error('Rate limited. Please wait a moment and try again.');
      } else if (response.status === 500 || response.status === 502) {
        log.error('Server error. Please try again in a moment.');
        log.info(chalk.dim(`Details: ${errMsg}`));
      } else {
        log.error(`${errMsg}`);
      }
      process.exit(1);
    }

    // ── Read and process the SSE stream ───────────────────────────────────
    const { blocks, stopReason, usage, creditInfo } = await readStream(
      response,
      round,
    );

    // Accumulate token usage
    if (usage) {
      accumulated.inputTokens += usage.inputTokens;
      accumulated.outputTokens += usage.outputTokens;
    }

    // Update credit info from server events
    if (creditInfo) {
      latestCreditInfo = creditInfo;
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

        const toolName = block.name as ToolName;

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

  // ── Clean up exit handlers ────────────────────────────────────────────────
  process.removeListener('SIGINT', exitHandler);
  process.removeListener('SIGTERM', exitHandler);

  // ── Report usage ──────────────────────────────────────────────────────────
  console.log();
  log.divider();
  log.info(
    chalk.dim('Tokens used: ') +
      chalk.white(`${accumulated.inputTokens.toLocaleString()} input`) +
      chalk.dim(' + ') +
      chalk.white(`${accumulated.outputTokens.toLocaleString()} output`),
  );

  // Display credit info from server (deducted server-side)
  if (latestCreditInfo.creditsUsed > 0) {
    log.info(
      chalk.dim('Credits used: ') +
        chalk.white(`${latestCreditInfo.creditsUsed}`),
    );
  }
  if (latestCreditInfo.remainingCredits >= 0) {
    log.credits(latestCreditInfo.remainingCredits);
  }

  log.success(chalk.bold('Generation complete!'));
  console.log();
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
    body: JSON.stringify({
      system: systemPrompt,
      messages,
      tools,
    }),
  });
}

// ─── SSE stream reader ───────────────────────────────────────────────────────

interface StreamResult {
  blocks: StreamBlock[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  creditInfo: CreditInfo | null;
}

async function readStream(
  response: Response,
  round: number,
): Promise<StreamResult> {
  const blocks: StreamBlock[] = [];
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;
  let creditInfo: CreditInfo | null = null;

  const indexToBlock = new Map<number, StreamBlock>();
  let textStarted = false;

  const spinner = createShimmerSpinner(
    `Thinking... (round ${round + 1}/${MAX_ROUNDS})`,
  );

  const body = response.body;
  if (!body) {
    spinner.stop();
    return { blocks, stopReason, usage: null, creditInfo: null };
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      // Track the current SSE event type for multi-line parsing
      let currentEventType: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ':') {
          currentEventType = null;
          continue;
        }

        // Parse SSE event type field
        if (trimmed.startsWith('event: ')) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') continue;

          // Handle custom BNA credit events from server
          if (
            currentEventType === 'bna_credits' ||
            currentEventType === 'bna_credits_final'
          ) {
            try {
              const creditData = JSON.parse(data);
              creditInfo = {
                creditsUsed: creditData.creditsUsed ?? 0,
                remainingCredits: creditData.remainingCredits ?? -1,
              };
            } catch {
              // Ignore parse errors on credit events
            }
            currentEventType = null;
            continue;
          }

          // Reset event type after processing data line
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
      console.log();
    }
  }

  return {
    blocks,
    stopReason,
    usage: { inputTokens, outputTokens },
    creditInfo,
  };
}

// ─── SSE event processor ─────────────────────────────────────────────────────

function processEvent(
  event: SSEEvent,
  ctx: {
    blocks: StreamBlock[];
    indexToBlock: Map<number, StreamBlock>;
    onText: (text: string) => void;
    onToolStart: () => void;
    onStopReason: (reason: string) => void;
    onUsage: (input: number, output: number) => void;
  },
) {
  const { blocks, indexToBlock, onText, onToolStart, onStopReason, onUsage } =
    ctx;

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
      onUsage(0, event.usage?.output_tokens ?? 0);
      if (event.delta.stop_reason) {
        onStopReason(event.delta.stop_reason);
      }
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
