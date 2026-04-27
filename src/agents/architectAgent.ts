// src/agents/architectAgent.ts
//
// Phase 1 agent. Takes the user's prompt + stack and produces a structured
// Blueprint. Has NO filesystem tools — it cannot write code. This is a
// hard architectural boundary, not a soft suggestion.
//
// Tools available:
//   - proposeBlueprint  : terminal tool; submits the final Blueprint
//   - lookupDocs        : optional, if the architect needs to consult skills
//                         while designing (rare but useful for e.g. presence)
//   - askUser           : ONE clarification permitted per architect run
//
// Token budget: typically 15-30K input. The architect runs in a fresh
// HTTP request — it shares no history with the build/frontend phases.

import chalk from 'chalk';
import { z } from 'zod';
import { refreshAuthToken } from '../utils/auth.js';
import {
  fetchStreamWithRetry,
  extractErrorMessage,
} from '../utils/apiClient.js';
import { readSkill, getSkillNamesForStack } from '../agent/skills.js';
import { emit, isUiActive } from '../ui/events.js';
import { log } from '../utils/logger.js';
import { startSpinner } from '../utils/liveSpinner.js';
import { architectSystemPrompt } from '../agent/architectPrompt.js';
import {
  type Blueprint,
  emptyBlueprint,
} from '../agent/blueprint.js';
import type { StackId } from '../commands/stacks.js';

const MAX_ROUNDS = 8;

export interface ArchitectInput {
  prompt: string;
  stack: StackId;
  authToken: string;
  /** Called when the architect asks a clarifying question. Resolve with the
   *  user's answer, which is fed back as a follow-up turn. */
  askUser?: (question: string, options?: string[]) => Promise<string>;
}

export interface ArchitectResult {
  ok: true;
  blueprint: Blueprint;
}

export interface ArchitectFailure {
  ok: false;
  reason: string;
}

// ─── Tool schemas (exposed to the model) ──────────────────────────────────

// We use Zod here so the schema doubles as a runtime validator — if the
// model returns malformed JSON, we catch it before it propagates.

const ThemeSchema = z.object({
  palette: z.enum([
    'warm-earth',
    'cool-clinical',
    'monochrome',
    'high-contrast',
    'pastel',
    'jewel-tones',
    'forest',
    'sunset',
    'oceanic',
    'custom',
  ]),
  rationale: z.string().min(10),
  accentHint: z.string().optional(),
  tone: z.enum(['terse', 'friendly', 'formal', 'playful', 'authoritative']),
});

const ScreenSchema = z.object({
  route: z.string(),
  name: z.string(),
  purpose: z.string(),
  isTab: z.boolean(),
  tabIcon: z
    .object({ ios: z.string(), android: z.string() })
    .optional(),
  reads: z.array(z.string()).default([]),
  writes: z.array(z.string()).default([]),
  uiComponents: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

const FieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean().optional(),
  index: z.boolean().optional(),
});

const IndexSchema = z.object({
  name: z.string(),
  fields: z.array(z.string()).min(1),
});

const RlsPolicySchema = z.object({
  name: z.string(),
  for: z.enum(['select', 'insert', 'update', 'delete']),
  expression: z.string(),
});

const TableSchema = z.object({
  name: z.string(),
  fields: z.array(FieldSchema).min(1),
  indexes: z.array(IndexSchema).default([]),
  rlsPolicies: z.array(RlsPolicySchema).optional(),
  notes: z.string().optional(),
});

const ArgSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean().optional(),
});

const ContractSchema = z.object({
  name: z.string(),
  kind: z.enum(['query', 'mutation', 'action']),
  description: z.string(),
  args: z.array(ArgSchema).default([]),
  returns: z.string(),
  authRequired: z.boolean(),
  notes: z.string().optional(),
});

const BlueprintSchema = z.object({
  meta: z.object({
    appName: z.string(),
    slug: z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        'slug must be lowercase letters, digits, hyphens only',
      ),
    bundleId: z.string().regex(/^[a-z0-9.]+$/, 'bundleId must be reverse-DNS'),
    scheme: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(10),
  }),
  theme: ThemeSchema,
  screens: z.array(ScreenSchema).min(1),
  dataModel: z.array(TableSchema).default([]),
  apiContracts: z.array(ContractSchema).default([]),
  envVars: z.array(z.string()).default([]),
  skillsNeeded: z.array(z.string()).default([]),
  architectNotes: z.string().optional(),
});

// ─── Tool definitions sent to the model ───────────────────────────────────

function buildArchitectTools(stack: StackId) {
  const skills = getSkillNamesForStack(stack);

  return [
    {
      name: 'proposeBlueprint',
      description:
        'Submit the complete app blueprint. Call this exactly ONCE when planning is complete. ' +
        'After this call, your turn ends and the Backend / Frontend Builder agents take over. ' +
        'Be thorough — every screen, table, and API contract needs to be specified.',
      input_schema: {
        type: 'object' as const,
        properties: {
          meta: {
            type: 'object',
            properties: {
              appName: { type: 'string' },
              slug: { type: 'string' },
              bundleId: { type: 'string' },
              scheme: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['appName', 'slug', 'bundleId', 'scheme', 'description'],
          },
          theme: {
            type: 'object',
            properties: {
              palette: {
                type: 'string',
                enum: [
                  'warm-earth',
                  'cool-clinical',
                  'monochrome',
                  'high-contrast',
                  'pastel',
                  'jewel-tones',
                  'forest',
                  'sunset',
                  'oceanic',
                  'custom',
                ],
              },
              rationale: { type: 'string' },
              accentHint: { type: 'string' },
              tone: {
                type: 'string',
                enum: ['terse', 'friendly', 'formal', 'playful', 'authoritative'],
              },
            },
            required: ['palette', 'rationale', 'tone'],
          },
          screens: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                route: { type: 'string' },
                name: { type: 'string' },
                purpose: { type: 'string' },
                isTab: { type: 'boolean' },
                tabIcon: {
                  type: 'object',
                  properties: {
                    ios: { type: 'string' },
                    android: { type: 'string' },
                  },
                  required: ['ios', 'android'],
                },
                reads: { type: 'array', items: { type: 'string' } },
                writes: { type: 'array', items: { type: 'string' } },
                uiComponents: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
              },
              required: ['route', 'name', 'purpose', 'isTab'],
            },
          },
          dataModel: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      type: { type: 'string' },
                      optional: { type: 'boolean' },
                      index: { type: 'boolean' },
                    },
                    required: ['name', 'type'],
                  },
                },
                indexes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      fields: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['name', 'fields'],
                  },
                },
                rlsPolicies: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      for: {
                        type: 'string',
                        enum: ['select', 'insert', 'update', 'delete'],
                      },
                      expression: { type: 'string' },
                    },
                    required: ['name', 'for', 'expression'],
                  },
                },
                notes: { type: 'string' },
              },
              required: ['name', 'fields'],
            },
          },
          apiContracts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['query', 'mutation', 'action'],
                },
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
              required: [
                'name',
                'kind',
                'description',
                'returns',
                'authRequired',
              ],
            },
          },
          envVars: { type: 'array', items: { type: 'string' } },
          skillsNeeded: { type: 'array', items: { type: 'string' } },
          architectNotes: { type: 'string' },
        },
        required: [
          'meta',
          'theme',
          'screens',
          'dataModel',
          'apiContracts',
          'envVars',
          'skillsNeeded',
        ],
      },
    },
    {
      name: 'lookupDocs',
      description:
        'Load a skill doc to inform your design. Available: ' +
        skills.join(', '),
      input_schema: {
        type: 'object' as const,
        properties: {
          skills: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 4,
          },
        },
        required: ['skills'],
      },
    },
    {
      name: 'askUser',
      description:
        'Ask ONE clarifying question if a critical requirement is genuinely ambiguous. ' +
        'Only use this if you cannot otherwise produce a sensible blueprint. ' +
        'Most apps should NOT need this — make sensible defaults instead.',
      input_schema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['question'],
      },
    },
  ];
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function runArchitectAgent(
  input: ArchitectInput,
): Promise<ArchitectResult | ArchitectFailure> {
  const tools = buildArchitectTools(input.stack);
  const systemPrompt = architectSystemPrompt(input.stack);

  // Architect's conversation is ISOLATED — fresh messages array, never shared.
  const messages: any[] = [
    {
      role: 'user',
      content:
        `# User request\n\n${input.prompt}\n\n` +
        `# Stack\n\n${input.stack}\n\n` +
        `Plan this app and call \`proposeBlueprint\` with the complete specification. ` +
        `Do not produce code. Do not call any other terminal tool besides \`proposeBlueprint\`.`,
    },
  ];

  let authToken = input.authToken;

  // Spinner / UI feedback
  const uiMode = isUiActive();
  let spinner: ReturnType<typeof startSpinner> | null = null;
  if (uiMode) {
    emit({ type: 'info', text: chalk.dim('Phase 1/3 — planning architecture') });
    emit({ type: 'thinking-start', round: 1, maxRounds: MAX_ROUNDS });
  } else {
    spinner = startSpinner(chalk.cyan('Phase 1/3 — planning architecture'));
  }

  const stopSpinner = () => {
    if (uiMode) emit({ type: 'thinking-stop' });
    else spinner?.stop();
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let response: Response;
      try {
        response = await fetchStreamWithRetry(
          authToken,
          systemPrompt,
          messages,
          tools,
          { label: 'Architect' },
        );
      } catch (err: any) {
        return {
          ok: false,
          reason: `Architect network error: ${err.message ?? 'unknown'}`,
        };
      }

      if (response.status === 401) {
        const refreshed = await refreshAuthToken();
        if (!refreshed) {
          return {
            ok: false,
            reason: 'Authentication expired. Run `bna login`.',
          };
        }
        authToken = refreshed;
        round--; // retry this round
        continue;
      }

      if (response.status === 402) {
        return {
          ok: false,
          reason:
            'Insufficient credits. Visit https://ai.ahmedbna.com/credits.',
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: `Architect — ${await extractErrorMessage(response)}`,
        };
      }

      // Parse the streaming response (architect is short — we collect full
      // blocks before processing because no live streaming UX is needed)
      const { blocks } = await collectStreamBlocks(response);

      // Build assistant message for history
      const assistantContent: any[] = [];
      const toolResults: any[] = [];
      let proposedBlueprint: any = null;
      let askUserCall: { question: string; options?: string[] } | null = null;

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

        if (block.name === 'proposeBlueprint') {
          proposedBlueprint = block.input;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Blueprint received. Validating...',
          });
        } else if (block.name === 'lookupDocs') {
          const skills: string[] = block.input.skills ?? [];
          const content = skills
            .map((s) => `## ${s}\n\n${readSkill(s)}`)
            .join('\n\n---\n\n');
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content,
          });
        } else if (block.name === 'askUser') {
          askUserCall = {
            question: block.input.question,
            options: block.input.options,
          };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: '(paused — waiting for user response)',
          });
        } else {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: tool "${block.name}" is not available to the architect.`,
          });
        }
      }

      messages.push({ role: 'assistant', content: assistantContent });

      // Handle proposed blueprint
      if (proposedBlueprint) {
        const validated = BlueprintSchema.safeParse(proposedBlueprint);
        if (!validated.success) {
          // Send validation errors back to the architect so it can fix them
          const errorReport = validated.error.issues
            .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n');
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: blocks.find(
                  (b: any) => b.name === 'proposeBlueprint',
                )?.id,
                content: `Blueprint validation failed:\n${errorReport}\n\nFix the issues and call proposeBlueprint again.`,
              },
            ],
          });
          continue;
        }

        // Validated blueprint!
        stopSpinner();
        if (uiMode) {
          emit({
            type: 'success',
            text: `Architecture planned: ${validated.data.screens.length} screens, ${validated.data.dataModel.length} tables, ${validated.data.apiContracts.length} APIs`,
          });
        } else {
          spinner?.succeed(chalk.green('Architecture planned'));
          log.info(
            chalk.dim(
              `  ${validated.data.screens.length} screens, ` +
                `${validated.data.dataModel.length} tables, ` +
                `${validated.data.apiContracts.length} APIs`,
            ),
          );
        }

        const blueprint: Blueprint = {
          version: 1,
          ...validated.data,
          meta: { ...validated.data.meta, stack: input.stack },
        };
        return { ok: true, blueprint };
      }

      // Handle clarification
      if (askUserCall) {
        if (!input.askUser) {
          return {
            ok: false,
            reason: `Architect needed clarification but no askUser handler was provided: "${askUserCall.question}"`,
          };
        }
        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults });
        }
        stopSpinner();
        const answer = await input.askUser(
          askUserCall.question,
          askUserCall.options,
        );
        if (uiMode) {
          emit({ type: 'thinking-start', round: round + 2, maxRounds: MAX_ROUNDS });
        } else {
          spinner = startSpinner(chalk.cyan('Phase 1/3 — refining plan'));
        }
        messages.push({ role: 'user', content: answer });
        continue;
      }

      // Continue with tool results
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // No tool call and no blueprint — architect has gone off-script.
      return {
        ok: false,
        reason:
          'Architect ended its turn without proposing a blueprint. This indicates a prompt or model issue.',
      };
    }

    return {
      ok: false,
      reason: `Architect did not produce a blueprint within ${MAX_ROUNDS} rounds.`,
    };
  } finally {
    stopSpinner();
  }
}

// ─── Stream collector (simpler than agent.ts since architect is short) ────

interface StreamBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  inputJson?: string;
}

async function collectStreamBlocks(
  response: Response,
): Promise<{ blocks: any[] }> {
  const blocks: any[] = [];
  const indexToBlock = new Map<number, StreamBlock>();

  const body = response.body;
  if (!body) return { blocks };

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

          processArchitectEvent(event, blocks, indexToBlock);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  return { blocks };
}

function processArchitectEvent(
  event: any,
  blocks: any[],
  indexToBlock: Map<number, StreamBlock>,
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
  }
}

// ─── Re-exports for convenience ───────────────────────────────────────────

export { emptyBlueprint };
