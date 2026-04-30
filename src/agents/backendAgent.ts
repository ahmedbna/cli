// src/agents/backendAgent.ts
//
// Phase 2 agent. Takes a Blueprint and writes the backend (schema, queries,
// mutations, actions for Convex; SQL migrations + supabase/api/* for Supabase).
//
// Conversation is ISOLATED from the Architect:
//   - Fresh messages array
//   - No architect history
//   - Only sees: blueprint + project root + locked-file list
//
// Tools available:
//   - createFile, editFile, viewFile, readMultipleFiles
//   - lookupDocs (backend skills only)
//   - addEnvironmentVariables
//   - runCommand (for `npx expo install` of any required server-side package)
//   - finish (returns BackendOutcome with the actual implemented contracts)
//
// Tools intentionally NOT available:
//   - searchFiles (the agent already knows the layout from the blueprint)
//   - listDirectory (same reason)
//   - askUser (no clarification — the architect already settled the design)

import chalk from 'chalk';
import { z } from 'zod';
import { refreshAuthToken } from '../utils/auth.js';
import {
  fetchStreamWithRetry,
  extractErrorMessage,
} from '../utils/apiClient.js';
import {
  buildToolDefinitions,
  executeTool,
  type ToolName,
} from '../agent/tools.js';
import { backendSystemPrompt } from '../agent/architectPrompt.js';
import {
  type Blueprint,
  type ApiContract,
  formatTablesForAgent,
  formatContractsForAgent,
} from '../agent/blueprint.js';
import type { InstallManager } from '../utils/installManager.js';
import { emit, isUiActive } from '../ui/events.js';
import { log } from '../utils/logger.js';
import { startSpinner } from '../utils/liveSpinner.js';
import { ContextManager } from '../agent/contextManager.js';

const MAX_ROUNDS = 25;

export interface BackendInput {
  blueprint: Blueprint;
  projectRoot: string;
  installManager: InstallManager;
  authToken: string;
}

export interface BackendOutcome {
  ok: true;
  /** Contracts as they were ACTUALLY implemented. May differ from the
   *  architect's proposal if the agent had to amend signatures. */
  finalContracts: ApiContract[];
  /** Files the agent created or modified */
  filesWritten: string[];
}

export interface BackendFailure {
  ok: false;
  reason: string;
}

// ─── The "report what you built" tool ──────────────────────────────────────

const ContractReportSchema = z.object({
  finalContracts: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['query', 'mutation', 'action']),
        description: z.string(),
        args: z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              optional: z.boolean().optional(),
            }),
          )
          .default([]),
        returns: z.string(),
        authRequired: z.boolean(),
        notes: z.string().optional(),
      }),
    )
    .min(0),
  filesWritten: z.array(z.string()).default([]),
  summary: z.string().optional(),
});

const finishBackendTool = {
  name: 'finishBackend',
  description:
    'Signal that backend implementation is complete. Provide the final list of API ' +
    'contracts AS IMPLEMENTED — including any signature changes from the original ' +
    'blueprint. The Frontend Builder will use this list verbatim. After this call, ' +
    'your turn ends.',
  input_schema: {
    type: 'object' as const,
    properties: {
      finalContracts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            kind: { type: 'string', enum: ['query', 'mutation', 'action'] },
            description: { type: 'string' },
            args: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string' },
                  optional: { type: 'boolean' },
                },
                required: ['name', 'type'],
              },
            },
            returns: { type: 'string' },
            authRequired: { type: 'boolean' },
            notes: { type: 'string' },
          },
          required: ['name', 'kind', 'description', 'returns', 'authRequired'],
        },
      },
      filesWritten: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['finalContracts'],
  },
};

// ─── Stack → backend tech mapping ─────────────────────────────────────────

function backendTechForStack(stack: string): string | null {
  // The stack id is `<frontend>-<backend>`; the backend tech is the suffix.
  // Stacks without a backend (e.g. plain `expo`) return null and the backend
  // agent isn't invoked anyway.
  const parts = stack.split('-');
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

// ─── Main entry ────────────────────────────────────────────────────────────

export async function runBackendAgent(
  input: BackendInput,
): Promise<BackendOutcome | BackendFailure> {
  const { blueprint, projectRoot, installManager } = input;
  let authToken = input.authToken;

  // Backend agent only sees skills for ITS backend tech — never expo skills.
  // expo-convex → ['convex']; expo-supabase → ['supabase'].
  const backendTech = backendTechForStack(blueprint.meta.stack);

  // Backend agent gets a SUBSET of tools — no exploration tools.
  const allTools = buildToolDefinitions(blueprint.meta.stack, {
    restrictTechs: backendTech ? [backendTech] : [],
  }).filter((t) =>
    [
      'createFile',
      'editFile',
      'viewFile',
      'readMultipleFiles',
      'lookupDocs',
      'addEnvironmentVariables',
      'runCommand',
      'checkDependencies',
    ].includes(t.name),
  );
  const tools = [...allTools, finishBackendTool];

  // Construct a focused initial message — the agent doesn't need to
  // figure out what to build, only HOW to build it.
  const userMessage = buildBackendUserMessage(blueprint, projectRoot);

  // Fresh context manager — no architect carryover.
  const context = new ContextManager({
    keepRecentRounds: 3,
    toolResultMaxChars: 400,
    createFileContentMaxChars: 200,
    viewDedupWindow: 4,
  });
  context.setInitialMessage(userMessage);

  const systemPrompt = backendSystemPrompt(blueprint.meta.stack);
  const toolCtx = { projectRoot, installManager };

  const uiMode = isUiActive();
  if (uiMode) {
    emit({ type: 'info', text: chalk.dim('Phase 2/3 — building backend') });
  } else {
    log.info(chalk.cyan('Phase 2/3 — building backend'));
  }

  const filesWrittenSet = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let response: Response;
    try {
      response = await fetchStreamWithRetry(
        authToken,
        systemPrompt,
        context.getMessages(),
        tools,
        { label: 'Backend' },
      );
    } catch (err: any) {
      return {
        ok: false,
        reason: `Backend network error: ${err.message ?? 'unknown'}`,
      };
    }

    if (response.status === 401) {
      const refreshed = await refreshAuthToken();
      if (!refreshed) {
        return { ok: false, reason: 'Authentication expired during backend build.' };
      }
      authToken = refreshed;
      round--;
      continue;
    }

    if (response.status === 402) {
      return {
        ok: false,
        reason: 'Insufficient credits during backend build.',
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `Backend — ${await extractErrorMessage(response)}`,
      };
    }

    const { blocks, stopReason } = await readStreamForBackend(response, round);

    const assistantContent: any[] = [];
    const toolResults: any[] = [];
    let finishCall: BackendOutcome | null = null;

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

      if (block.name === 'finishBackend') {
        const validated = ContractReportSchema.safeParse(block.input);
        if (!validated.success) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content:
              'finishBackend payload invalid:\n' +
              validated.error.issues
                .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
                .join('\n'),
          });
          continue;
        }
        finishCall = {
          ok: true,
          finalContracts: validated.data.finalContracts as ApiContract[],
          filesWritten: [
            ...filesWrittenSet,
            ...(validated.data.filesWritten ?? []),
          ],
        };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'acknowledged',
        });
        continue;
      }

      // Regular tool — execute through the shared tool router
      const toolName = block.name as ToolName;
      let result: string;
      try {
        result = await executeTool(toolCtx, toolName, block.input);
        // Track file mutations for the outcome report
        if (
          ['createFile', 'editFile', 'deleteFile', 'renameFile'].includes(
            toolName,
          )
        ) {
          const p = block.input.filePath ?? block.input.oldPath;
          if (p) filesWrittenSet.add(p);
        }
      } catch (err: any) {
        result = `Error: ${err.message}`;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    context.addAssistantMessage(assistantContent);

    if (finishCall) {
      if (toolResults.length > 0) context.addToolResults(toolResults);
      if (uiMode) {
        emit({
          type: 'success',
          text: `Backend built: ${finishCall.finalContracts.length} APIs, ${finishCall.filesWritten.length} files`,
        });
      } else {
        log.success(
          chalk.green(
            `Backend complete: ${finishCall.finalContracts.length} APIs, ${finishCall.filesWritten.length} files`,
          ),
        );
      }
      return finishCall;
    }

    if (toolResults.length > 0) {
      context.addToolResults(toolResults);
      continue;
    }

    if (stopReason === 'end_turn') {
      // Agent ended without calling finishBackend — treat as failure
      return {
        ok: false,
        reason:
          'Backend agent ended its turn without calling finishBackend. Build may be incomplete.',
      };
    }

    if (stopReason === 'max_tokens') {
      context.addUserText('Please continue.');
      continue;
    }

    return {
      ok: false,
      reason: `Backend agent stopped unexpectedly (reason: ${stopReason}).`,
    };
  }

  return {
    ok: false,
    reason: `Backend agent did not finish within ${MAX_ROUNDS} rounds.`,
  };
}

// ─── Build the focused initial message ─────────────────────────────────────

function buildBackendUserMessage(
  blueprint: Blueprint,
  projectRoot: string,
): string {
  const stack = blueprint.meta.stack;
  const sections: string[] = [];

  sections.push(
    `# Build the backend for: ${blueprint.meta.appName}`,
  );
  sections.push(
    `Project root: ${projectRoot}`,
    `Stack: ${stack}`,
    `Description: ${blueprint.meta.description}`,
  );

  sections.push(
    '\n## Data model\n\n' + formatTablesForAgent(blueprint.dataModel),
  );

  sections.push(
    '\n## API contracts to implement (these are the EXACT signatures the frontend will consume)\n\n' +
      formatContractsForAgent(blueprint.apiContracts),
  );

  if (blueprint.envVars.length > 0) {
    sections.push(
      '\n## Environment variables to queue\n\n' +
        blueprint.envVars.map((v) => `  - ${v}`).join('\n'),
    );
  }

  if (blueprint.skillsNeeded.length > 0) {
    sections.push(
      '\n## Skills the architect identified\n\n' +
        blueprint.skillsNeeded.map((s) => `  - ${s}`).join('\n') +
        '\n\nLoad these via `lookupDocs` before writing the relevant files.',
    );
  }

  if (blueprint.architectNotes) {
    sections.push(
      '\n## Architect notes (read carefully — these explain decisions)\n\n' +
        blueprint.architectNotes,
    );
  }

  sections.push(
    '\n## Your task',
    '',
    '1. Implement every table in `dataModel` and every contract in `apiContracts`.',
    '2. If a contract requires a helper or auxiliary function not in the list, ADD IT to your `finishBackend` report so the frontend knows about it.',
    '3. If you must change a contract\'s args or return type during implementation, REPORT THE CHANGE in `finishBackend`. The frontend will use the post-implementation signatures.',
    '4. Do NOT touch frontend code (theme, components, screens, app.json). Frontend is a separate phase.',
    '5. Do NOT add tables or contracts that aren\'t needed for the listed APIs.',
    '6. When complete, call `finishBackend` with the final contract list.',
  );

  return sections.join('\n');
}

// ─── Stream reader (no live UI — agent runs as a discrete phase) ───────────

interface StreamBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  inputJson?: string;
}

async function readStreamForBackend(
  response: Response,
  round: number,
): Promise<{ blocks: any[]; stopReason: string }> {
  const blocks: any[] = [];
  const indexToBlock = new Map<number, StreamBlock>();
  let stopReason = 'end_turn';

  const uiMode = isUiActive();
  let spinner: ReturnType<typeof startSpinner> | null = null;
  let textStarted = false;

  if (uiMode) {
    emit({ type: 'thinking-start', round: round + 1, maxRounds: MAX_ROUNDS });
  } else {
    spinner = startSpinner(
      chalk.hex('#a5b4fc')(`Backend (round ${round + 1})`),
    );
  }

  const stopThinking = () => {
    if (uiMode) emit({ type: 'thinking-stop' });
    else spinner?.stop();
  };

  const body = response.body;
  if (!body) {
    stopThinking();
    return { blocks, stopReason };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
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
            currentEventType = null;
            continue;
          }
          currentEventType = null;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // Process events; suppress assistant text streaming for backend
          // (UI mode only shows tool lines; backend reasoning isn't shown).
          processBackendEvent(event, blocks, indexToBlock, (reason) => {
            stopReason = reason;
          }, () => {
            if (!textStarted) {
              stopThinking();
              textStarted = true;
            }
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
    stopThinking();
  }

  return { blocks, stopReason };
}

function processBackendEvent(
  event: any,
  blocks: any[],
  indexToBlock: Map<number, StreamBlock>,
  onStopReason: (r: string) => void,
  onContent: () => void,
) {
  switch (event.type) {
    case 'content_block_start': {
      const cb = event.content_block;
      if (cb.type === 'text') {
        const block = { type: 'text' as const, text: cb.text ?? '' };
        blocks.push(block);
        indexToBlock.set(event.index, block);
      } else {
        const block = {
          type: 'tool_use' as const,
          id: cb.id,
          name: cb.name,
          inputJson: '',
          input: {},
        };
        blocks.push(block);
        indexToBlock.set(event.index, block);
        onContent();
      }
      break;
    }
    case 'content_block_delta': {
      const block = indexToBlock.get(event.index);
      if (!block) break;
      const delta = event.delta;
      if (delta.type === 'text_delta' && block.type === 'text') {
        block.text = (block.text ?? '') + delta.text;
      } else if (
        delta.type === 'input_json_delta' &&
        block.type === 'tool_use'
      ) {
        block.inputJson = (block.inputJson ?? '') + delta.partial_json;
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
      if (event.delta?.stop_reason) onStopReason(event.delta.stop_reason);
      break;
    }
  }
}
