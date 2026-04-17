// src/agent/agent.ts
//
// Core agentic loop with parallelized dependency installation.
//
// The agent now receives an InstallManager and starts generating files
// IMMEDIATELY — `npm install` runs in the background. When the model calls
// `runCommand` for an npm/npx command, the InstallManager automatically
// awaits the base install and serializes the call. This turns a previously
// sequential step into a parallel one.

import ora from 'ora';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { generalSystemPrompt } from './prompts.js';
import { refreshAuthToken } from '../utils/auth.js';
import { ContextManager } from './contextManager.js';
import type { InstallManager } from '../utils/installManager.js';
import { getAuthToken, CONVEX_SITE_URL } from '../utils/store.js';
import { toolDefinitions, executeTool, type ToolName } from './tools.js';

const MAX_ROUNDS = 30;

export interface AgentOptions {
  projectRoot: string;
  prompt: string;
  stack: 'expo' | 'expo-convex';
  authToken?: string;
  installManager: InstallManager;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface CreditInfo {
  creditsUsed: number;
  remainingCredits: number;
}

// ─── Anthropic SSE event types (unchanged) ──────────────────────────────────

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

// ─── Shimmer spinner ─────────────────────────────────────────────────────────

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
    spinner: { interval: 80, frames: SHIMMER_CHARS },
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
  const { projectRoot, prompt, stack, installManager } = options;

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
  let latestCreditInfo: CreditInfo = { creditsUsed: 0, remainingCredits: -1 };

  // ── Updated user message — tells the model about parallel installation ──
  const userMessage =
    `You are BNA, an expert AI assistant and senior software engineer creating an app with the following description:\n\n${prompt}\n\n` +
    `The project root is: ${projectRoot}\n` +
    `Stack: ${stack === 'expo-convex' ? 'Expo + Convex (full-stack)' : 'Expo only'}\n\n`;

  const context = new ContextManager({
    keepRecentRounds: 3,
    toolResultMaxChars: 400,
    createFileContentMaxChars: 200,
    viewDedupWindow: 4,
  });
  context.setInitialMessage(userMessage);

  log.divider();
  log.info(chalk.bold('Starting BNA Agent (parallel mode)...'));
  log.info(`Stack: ${chalk.cyan(stack)}`);
  log.info(`Project: ${chalk.cyan(projectRoot)}`);
  log.info(
    chalk.dim(
      `Install state: ${installManager.getStatus()} — agent starting in parallel`,
    ),
  );
  log.divider();

  const exitHandler = () => {
    console.log();
    log.divider();
    installManager.abort();
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
    log.warn('Agent interrupted.');
    process.exit(0);
  };

  process.on('SIGINT', exitHandler);
  process.on('SIGTERM', exitHandler);

  const toolCtx = { projectRoot, installManager };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let response: Response;
    try {
      response = await fetchStream(
        CONVEX_SITE_URL,
        authToken,
        systemPrompt,
        context.getMessages(),
        toolDefinitions,
      );
    } catch (err: any) {
      log.error(`Network error: ${err.message ?? 'Unknown error'}`);
      process.exit(1);
    }

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
            context.getMessages(),
            toolDefinitions,
          );
        } catch (err: any) {
          log.error(`Network error after refresh: ${err.message}`);
          process.exit(1);
        }
        if (response.status === 401) {
          log.error(
            'Authentication expired. Run `bna login` to re-authenticate.',
          );
          process.exit(1);
        }
      } else {
        log.error('Authentication expired and could not be refreshed.');
        process.exit(1);
      }
    }

    if (response.status === 402) {
      log.error(
        'Insufficient credits. Visit https://ai.ahmedbna.com/credits to purchase more.',
      );
      process.exit(1);
    }

    if (!response.ok) {
      let errMsg = `API request failed (${response.status})`;
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const errJson = await response.json();
          errMsg = errJson.error ?? errJson.message ?? JSON.stringify(errJson);
        } else {
          errMsg = await response.text();
        }
      } catch {
        /* ignore */
      }
      log.error(errMsg);
      process.exit(1);
    }

    const { blocks, stopReason, usage, creditInfo } = await readStream(
      response,
      round,
    );

    if (usage) {
      accumulated.inputTokens += usage.inputTokens;
      accumulated.outputTokens += usage.outputTokens;
    }
    if (creditInfo) latestCreditInfo = creditInfo;

    const assistantContent: any[] = [];
    const toolResults: any[] = [];

    // Tool execution is now async (runCommand awaits install state).
    // We execute tool calls within a round SEQUENTIALLY to keep
    // deterministic file ordering, but the execution itself can await.
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

        if (toolName === 'viewFile' && block.input.filePath) {
          const stub = context.getDedupStubForView(block.input.filePath);
          if (stub) {
            result = stub;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
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
      }
    }

    context.addAssistantMessage(assistantContent);

    if (toolResults.length > 0) {
      context.addToolResults(toolResults);
      continue;
    }

    if (stopReason === 'end_turn') break;

    if (stopReason === 'max_tokens') {
      log.warn('Response truncated — continuing...');
      context.addUserText('Please continue where you left off.');
      continue;
    }

    // if (stopReason === 'max_tokens') {
    //   log.warn('Response truncated — continuing...');
    //   context.addToolResults([
    //     {
    //       type: 'tool_result',
    //       tool_use_id: 'continuation',
    //       content: 'Please continue where you left off.',
    //     },
    //   ]);
    //   // Actually, max_tokens means no tool_use — so we need a plain user message.
    //   // Simpler: push a text user message via a helper, OR skip compaction here.
    //   continue;
    // }

    break;
  }

  process.removeListener('SIGINT', exitHandler);
  process.removeListener('SIGTERM', exitHandler);

  console.log();
  log.divider();
  log.info(
    chalk.dim('Tokens used: ') +
      chalk.white(`${accumulated.inputTokens.toLocaleString()} input`) +
      chalk.dim(' + ') +
      chalk.white(`${accumulated.outputTokens.toLocaleString()} output`),
  );

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
    body: JSON.stringify({ system: systemPrompt, messages, tools }),
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
            try {
              const creditData = JSON.parse(data);
              creditInfo = {
                creditsUsed: creditData.creditsUsed ?? 0,
                remainingCredits: creditData.remainingCredits ?? -1,
              };
            } catch {
              /* ignore */
            }
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
