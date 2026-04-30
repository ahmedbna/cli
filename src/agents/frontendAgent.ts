// src/agents/frontendAgent.ts
//
// Phase 3 agent. Takes a Blueprint (with the post-backend contracts) and
// writes the frontend: theme, UI components, screens.
//
// Conversation is ISOLATED from both the Architect and Backend Builder:
//   - Fresh messages array
//   - No backend implementation history
//   - Only sees: blueprint (with FINAL contracts) + project root
//
// The blueprint itself (persisted at .bna/blueprint.json) is the structural
// record of the app design intent from that file via agentTurn's blueprint context injection.
//
// The frontend agent has access to the full filesystem tool belt because
// it operates over a wider surface (theme, components, multiple screens,
// app.json) and benefits from being able to inspect template files.
//
// Tools intentionally NOT available:
//   - askUser (no clarification — design is settled)

import chalk from 'chalk';
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
import { frontendSystemPrompt } from '../agent/architectPrompt.js';
import {
  type Blueprint,
  formatScreensForAgent,
  formatContractsForAgent,
} from '../agent/blueprint.js';
import type { InstallManager } from '../utils/installManager.js';
import { emit, isUiActive } from '../ui/events.js';
import { log } from '../utils/logger.js';
import { startSpinner } from '../utils/liveSpinner.js';
import { ContextManager } from '../agent/contextManager.js';
import { finishToolDefinition } from '../session/planner.js';
import { randomUUID } from 'node:crypto';

const MAX_ROUNDS = 30;

export interface FrontendInput {
  blueprint: Blueprint;
  projectRoot: string;
  installManager: InstallManager;
  authToken: string;
}

export interface FrontendOutcome {
  ok: true;
  filesWritten: string[];
  summary?: string;
}

export interface FrontendFailure {
  ok: false;
  reason: string;
}

// ─── Main entry ────────────────────────────────────────────────────────────

export async function runFrontendAgent(
  input: FrontendInput,
): Promise<FrontendOutcome | FrontendFailure> {
  const { blueprint, projectRoot, installManager } = input;
  let authToken = input.authToken;

  // Frontend gets the full filesystem tool belt (no askUser). Skill catalog
  // is locked to expo only — backend skills are off-limits at this phase.
  const allTools = buildToolDefinitions(blueprint.meta.stack, {
    restrictTechs: ['expo'],
  });
  const tools = [...allTools, finishToolDefinition];

  const userMessage = buildFrontendUserMessage(blueprint, projectRoot);

  const context = new ContextManager({
    keepRecentRounds: 3,
    toolResultMaxChars: 400,
    createFileContentMaxChars: 200,
    viewDedupWindow: 4,
  });
  context.setInitialMessage(userMessage);

  const systemPrompt = frontendSystemPrompt(blueprint.meta.stack);
  const toolCtx = { projectRoot, installManager };

  const uiMode = isUiActive();
  if (uiMode) {
    emit({ type: 'info', text: chalk.dim('Phase 3/3 — building frontend') });
  } else {
    log.info(chalk.cyan('Phase 3/3 — building frontend'));
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
        { label: 'Frontend' },
      );
    } catch (err: any) {
      return {
        ok: false,
        reason: `Frontend network error: ${err.message ?? 'unknown'}`,
      };
    }

    if (response.status === 401) {
      const refreshed = await refreshAuthToken();
      if (!refreshed) {
        return {
          ok: false,
          reason: 'Authentication expired during frontend build.',
        };
      }
      authToken = refreshed;
      round--;
      continue;
    }

    if (response.status === 402) {
      return {
        ok: false,
        reason: 'Insufficient credits during frontend build.',
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: `Frontend — ${await extractErrorMessage(response)}`,
      };
    }

    const { blocks, stopReason } = await readStreamForFrontend(response, round);

    const assistantContent: any[] = [];
    const toolResults: any[] = [];
    let finishCall: { summary?: string } | null = null;

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

      if (block.name === 'finish') {
        finishCall = { summary: block.input?.summary };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'acknowledged',
        });
        continue;
      }

      const toolName = block.name as ToolName;

      if (toolName === 'viewFile' && block.input.filePath) {
        const stub = context.getDedupStubForView(block.input.filePath);
        if (stub) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: stub,
          });
          continue;
        }
      }

      let result: string;
      try {
        result = await executeTool(toolCtx, toolName, block.input);
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
          text: `Frontend built (${filesWrittenSet.size} files)`,
        });
      } else {
        log.success(
          chalk.green(`Frontend complete (${filesWrittenSet.size} files)`),
        );
      }
      return {
        ok: true,
        filesWritten: Array.from(filesWrittenSet),
        summary: finishCall.summary,
      };
    }

    if (toolResults.length > 0) {
      context.addToolResults(toolResults);
      continue;
    }

    if (stopReason === 'end_turn') {
      // Treat natural end_turn as success (frontend agents may not always
      // call finish explicitly).
      if (uiMode) {
        emit({
          type: 'success',
          text: `Frontend built (${filesWrittenSet.size} files)`,
        });
      }
      return {
        ok: true,
        filesWritten: Array.from(filesWrittenSet),
      };
    }

    if (stopReason === 'max_tokens') {
      context.addUserText('Please continue.');
      continue;
    }

    return {
      ok: false,
      reason: `Frontend agent stopped unexpectedly (reason: ${stopReason}).`,
    };
  }

  return {
    ok: false,
    reason: `Frontend agent did not finish within ${MAX_ROUNDS} rounds.`,
  };
}

// ─── Initial message constructor ───────────────────────────────────────────

function buildFrontendUserMessage(
  blueprint: Blueprint,
  projectRoot: string,
): string {
  const sections: string[] = [];

  sections.push(`# Build the frontend for: ${blueprint.meta.appName}`);
  sections.push(
    `Project root: ${projectRoot}`,
    `Stack: ${blueprint.meta.stack}`,
    `Description: ${blueprint.meta.description}`,
  );

  sections.push(
    '',
    '## App identity (update app.json with these)',
    `  expo.name: ${blueprint.meta.appName}`,
    `  expo.slug: ${blueprint.meta.slug}`,
    `  expo.scheme: ${blueprint.meta.scheme}`,
    `  expo.ios.bundleIdentifier: ${blueprint.meta.bundleId}`,
    `  expo.android.package: ${blueprint.meta.bundleId}`,
  );

  sections.push(
    '',
    '## Theme direction',
    `  palette: ${blueprint.theme.palette}`,
    `  rationale: ${blueprint.theme.rationale}`,
    blueprint.theme.accentHint
      ? `  accentHint: ${blueprint.theme.accentHint}`
      : '',
    `  tone: ${blueprint.theme.tone}`,
  );

  sections.push('', '## Screens to implement', '');
  sections.push(formatScreensForAgent(blueprint.screens));

  if (blueprint.apiContracts.length > 0) {
    sections.push(
      '',
      '## Available APIs (already implemented — use EXACTLY these signatures)',
      '',
      formatContractsForAgent(blueprint.apiContracts),
    );
    sections.push(
      '',
      'These signatures are FINAL. The backend has been built with these exact contracts. ' +
        'Do not invent new endpoints, new args, or new return shapes. If a screen needs ' +
        'data not exposed by these APIs, derive it on the client.',
    );
  } else {
    sections.push(
      '',
      '## No backend',
      'This is a frontend-only stack. Use local state / AsyncStorage / MMKV per the architect notes.',
    );
  }

  if (blueprint.dataModel.length > 0 && blueprint.meta.stack === 'expo') {
    sections.push(
      '',
      '## Local data shape',
      '',
      blueprint.dataModel
        .map(
          (t) =>
            `${t.name}:\n` +
            t.fields
              .map(
                (f) =>
                  `  ${f.name}: ${f.type}${f.optional ? ' (optional)' : ''}`,
              )
              .join('\n') +
            (t.notes ? `\n  notes: ${t.notes}` : ''),
        )
        .join('\n\n'),
    );
  }

  if (blueprint.envVars.length > 0) {
    sections.push(
      '',
      '## Environment variables (already queued)',
      blueprint.envVars.map((v) => `  - ${v} → process.env.${v}`).join('\n'),
    );
  }

  if (blueprint.skillsNeeded.length > 0) {
    const frontendSkills = blueprint.skillsNeeded.filter((s) =>
      s.startsWith('expo-'),
    );
    if (frontendSkills.length > 0) {
      sections.push(
        '',
        '## Skills to load',
        frontendSkills.map((s) => `  - ${s}`).join('\n') +
          '\n\nLoad these via `lookupDocs` before writing the relevant code.',
      );
    }
  }

  if (blueprint.architectNotes) {
    sections.push('', '## Architect notes', blueprint.architectNotes);
  }

  sections.push(
    '',
    '## Your task',
    '',
    '1. Update `app.json` with the identity above.',
    '2. Rewrite `theme/colors.ts` with a unique palette matching the theme direction.',
    '3. Build/restyle `components/ui/*` for every component referenced in screens.',
    '4. Implement `app/(home)/_layout.tsx` with NativeTabs for the tab screens.',
    '5. Implement every screen in `screens` using only the listed APIs and components.',
    '6. Call `finish({ summary })` when done.',
    '',
    'Do NOT modify any backend file (convex/* or supabase/*). The backend is settled.',
  );

  return sections.filter(Boolean).join('\n');
}

// ─── Stream reader ─────────────────────────────────────────────────────────

interface StreamBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  inputJson?: string;
}

async function readStreamForFrontend(
  response: Response,
  round: number,
): Promise<{ blocks: any[]; stopReason: string }> {
  const blocks: any[] = [];
  const indexToBlock = new Map<number, StreamBlock>();
  let stopReason = 'end_turn';
  const uiMode = isUiActive();

  let assistantId: string | null = null;
  let textStarted = false;
  let spinner: ReturnType<typeof startSpinner> | null = null;

  if (uiMode) {
    emit({ type: 'thinking-start', round: round + 1, maxRounds: MAX_ROUNDS });
  } else {
    spinner = startSpinner(
      chalk.hex('#a5b4fc')(`Frontend (round ${round + 1})`),
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

          processFrontendEvent(event, blocks, indexToBlock, {
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
    stopThinking();
  }

  return { blocks, stopReason };
}

function processFrontendEvent(
  event: any,
  blocks: any[],
  indexToBlock: Map<number, StreamBlock>,
  ctx: {
    onText: (t: string) => void;
    onToolStart: () => void;
    onStopReason: (r: string) => void;
  },
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
        ctx.onToolStart();
      }
      break;
    }
    case 'content_block_delta': {
      const block = indexToBlock.get(event.index);
      if (!block) break;
      const delta = event.delta;
      if (delta.type === 'text_delta' && block.type === 'text') {
        block.text = (block.text ?? '') + delta.text;
        ctx.onText(delta.text);
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
      if (event.delta?.stop_reason) ctx.onStopReason(event.delta.stop_reason);
      break;
    }
  }
}
