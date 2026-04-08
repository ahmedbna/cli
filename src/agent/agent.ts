// src/agent/agent.ts
// Core agentic loop: BNA server proxy → tool execution → feed results back
//
// The CLI does NOT call Anthropic directly. Instead it sends messages to the
// BNA server at /api/cli-chat, which uses the server's own ANTHROPIC_API_KEY.
// This way users never need to configure an API key — they just need to be
// authenticated with `bna login`.

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

export async function runAgent(options: AgentOptions): Promise<void> {
  const { projectRoot, prompt, stack } = options;

  // Ensure user is authenticated — the server uses its own API key
  let authToken: string;
  try {
    authToken = getAuthToken();
  } catch {
    log.error(
      'Not authenticated. Run `bna login` first.\n' +
        '  The BNA server handles API calls — no API key needed on your end.',
    );
    process.exit(1);
  }

  const systemPrompt = buildSystemPrompt(stack);

  const accumulated: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  // Build initial messages
  const messages: Array<{ role: string; content: any }> = [
    {
      role: 'user',
      content: `Create a full-stack mobile application with the following description:\n\n${prompt}\n\nThe project root is: ${projectRoot}\nStack: ${stack === 'expo-convex' ? 'Expo + Convex (full-stack)' : 'Expo only'}\n\nPlease build all the necessary files and set up the project. Start by planning the architecture, then create the theme, UI components, schema, backend functions, and screens. After writing all files, run the necessary setup commands.`,
    },
  ];

  log.divider();
  log.info(chalk.bold('Starting BNA Agent...'));
  log.info(`Stack: ${chalk.cyan(stack)}`);
  log.info(`Project: ${chalk.cyan(projectRoot)}`);
  log.divider();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const spinner = ora({
      text: chalk.dim(`Thinking... (round ${round + 1}/${MAX_ROUNDS})`),
      color: 'yellow',
    }).start();

    let response: any;
    try {
      response = await callBnaServer({
        authToken,
        systemPrompt,
        messages,
        tools: toolDefinitions,
      });
    } catch (err: any) {
      spinner.fail('API request failed');
      if (err.status === 401) {
        log.error(
          'Authentication expired. Run `bna login` to re-authenticate.',
        );
      } else if (err.status === 402) {
        log.error(
          'Insufficient credits. Visit https://ai.ahmedbna.com/credits to purchase more.',
        );
      } else if (err.status === 429) {
        log.error('Rate limited. Please wait a moment and try again.');
      } else {
        log.error(err.message ?? 'Unknown error');
      }
      process.exit(1);
    }

    spinner.stop();

    // Track usage
    if (response.usage) {
      accumulated.inputTokens += response.usage.input_tokens ?? 0;
      accumulated.outputTokens += response.usage.output_tokens ?? 0;
    }

    // Process content blocks
    const assistantContent: any[] = response.content;
    const toolResults: any[] = [];

    for (const block of assistantContent) {
      if (block.type === 'text') {
        const cleaned = stripBoltXml(block.text);
        if (cleaned.trim()) {
          console.log();
          console.log(chalk.white(cleaned));
        }
      } else if (block.type === 'tool_use') {
        const toolName = block.name as ToolName;
        const toolInput = block.input as Record<string, any>;

        log.info(
          chalk.dim('Tool: ') +
            chalk.cyan(toolName) +
            (toolName === 'createFile'
              ? chalk.dim(` → ${toolInput.filePath}`)
              : toolName === 'runCommand'
                ? chalk.dim(` → ${toolInput.command}`)
                : ''),
        );

        let result: string;
        try {
          result = executeTool(projectRoot, toolName, toolInput);
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

    // Add assistant message to history
    messages.push({ role: 'assistant', content: assistantContent });

    // If there were tool calls, add results and continue
    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // No tool calls and stop_reason is 'end_turn' → we're done
    if (response.stop_reason === 'end_turn') {
      break;
    }

    // stop_reason is 'max_tokens' → continue
    if (response.stop_reason === 'max_tokens') {
      log.warn('Response truncated — continuing...');
      messages.push({
        role: 'user',
        content: 'Please continue where you left off.',
      });
      continue;
    }

    break;
  }

  // Report usage
  console.log();
  log.divider();
  log.info(
    chalk.dim('Tokens used: ') +
      chalk.white(`${accumulated.inputTokens.toLocaleString()} input`) +
      chalk.dim(' + ') +
      chalk.white(`${accumulated.outputTokens.toLocaleString()} output`),
  );

  // Deduct credits
  if (options.onCreditsUsed) {
    await options.onCreditsUsed(
      accumulated.inputTokens,
      accumulated.outputTokens,
    );
  }

  log.success(chalk.bold('Generation complete!'));
  console.log();
}

// ─── Server proxy call ──────────────────────────────────────────────────────

async function callBnaServer(opts: {
  authToken: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: any }>;
  tools: any[];
}): Promise<any> {
  const resp = await fetch(`${API_BASE}/api/cli-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.authToken}`,
    },
    body: JSON.stringify({
      system: opts.systemPrompt,
      messages: opts.messages,
      tools: opts.tools,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const error: any = new Error(
      `BNA server error (${resp.status}): ${text || resp.statusText}`,
    );
    error.status = resp.status;
    throw error;
  }

  return resp.json();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripBoltXml(text: string): string {
  return text
    .replace(/<boltArtifact[^>]*>/g, '')
    .replace(/<\/boltArtifact>/g, '')
    .replace(/<boltAction[^>]*>[\s\S]*?<\/boltAction>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
