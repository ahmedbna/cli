// src/agent/agent.ts
// Core agentic loop: Anthropic API → tool execution → feed results back

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompts.js';
import { toolDefinitions, executeTool, type ToolName } from './tools.js';
import { log } from '../utils/logger.js';
import { store } from '../utils/store.js';
import chalk from 'chalk';
import ora from 'ora';

const MAX_ROUNDS = 30;
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 16384;

export interface AgentOptions {
  projectRoot: string;
  prompt: string;
  stack: 'expo' | 'expo-convex';
  apiKey?: string;
  onCreditsUsed?: (input: number, output: number) => Promise<void>;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export async function runAgent(options: AgentOptions): Promise<void> {
  const { projectRoot, prompt, stack, apiKey } = options;

  // Resolve API key: user's own key > stored key > error
  const resolvedKey =
    apiKey ?? store.get('anthropicApiKey') ?? process.env.ANTHROPIC_API_KEY;
  if (!resolvedKey) {
    log.error(
      'No Anthropic API key found. Set one with:\n' +
        '  bna config --api-key sk-ant-...\n' +
        'or set ANTHROPIC_API_KEY environment variable'
    );
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: resolvedKey });
  const systemPrompt = buildSystemPrompt(stack);

  const accumulated: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // Build initial messages
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Create a full-stack mobile application with the following description:\n\n${prompt}\n\nThe project root is: ${projectRoot}\nStack: ${stack === 'expo-convex' ? 'Expo + Convex (full-stack)' : 'Expo only'}\n\nPlease generate all the necessary files and set up the project. Start by planning the architecture, then create the theme, UI components, schema, backend functions, and screens. After writing all files, run the necessary setup commands.`,
    },
  ];

  log.divider();
  log.info(chalk.bold('Starting BNA Agent...'));
  log.info(`Model: ${chalk.cyan(MODEL)}`);
  log.info(`Stack: ${chalk.cyan(stack)}`);
  log.info(`Project: ${chalk.cyan(projectRoot)}`);
  log.divider();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const spinner = ora({
      text: chalk.dim(`Thinking... (round ${round + 1}/${MAX_ROUNDS})`),
      color: 'yellow',
    }).start();

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
      });
    } catch (err: any) {
      spinner.fail('API request failed');
      if (err.status === 401) {
        log.error('Invalid API key. Check your key with `bna config --show`');
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
      const cache = (response.usage as any);
      accumulated.cacheCreationInputTokens += cache.cache_creation_input_tokens ?? 0;
      accumulated.cacheReadInputTokens += cache.cache_read_input_tokens ?? 0;
    }

    // Process content blocks
    const assistantContent: Anthropic.ContentBlock[] = response.content;
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of assistantContent) {
      if (block.type === 'text') {
        // Stream text to terminal, stripping boltArtifact XML but keeping file action logs
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
                : '')
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
      continue; // next round
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
  const totalInput =
    accumulated.inputTokens +
    accumulated.cacheCreationInputTokens +
    accumulated.cacheReadInputTokens;
  log.info(
    chalk.dim('Tokens used: ') +
      chalk.white(`${totalInput.toLocaleString()} input`) +
      chalk.dim(' + ') +
      chalk.white(`${accumulated.outputTokens.toLocaleString()} output`)
  );

  // Deduct credits if using BNA server
  if (options.onCreditsUsed) {
    await options.onCreditsUsed(totalInput, accumulated.outputTokens);
  }

  log.success(chalk.bold('Generation complete!'));
  console.log();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripBoltXml(text: string): string {
  // Remove <boltArtifact> and <boltAction> tags but keep non-XML text
  return text
    .replace(/<boltArtifact[^>]*>/g, '')
    .replace(/<\/boltArtifact>/g, '')
    .replace(/<boltAction[^>]*>[\s\S]*?<\/boltAction>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
