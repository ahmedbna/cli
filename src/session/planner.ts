// src/session/planner.ts
//
// The Planner defines what an agent turn can produce.
//
// An agent turn is no longer a one-shot "generate everything then exit".
// It's a single round of model → tools → model, producing ONE of:
//
//   - complete    : agent signals it's done with the current user request
//   - clarify     : agent wants the user to answer a question before proceeding
//   - interrupted : the user pressed Ctrl-C mid-stream
//   - error       : network/API/internal failure
//
// The REPL consumes these results and decides what to do next.

export type TurnOutcome =
  | { kind: 'complete'; summary?: string }
  | { kind: 'clarify'; question: string; options?: string[] }
  | { kind: 'interrupted' }
  | { kind: 'error'; message: string };

/**
 * The `askUser` tool is how the planner signals it wants clarification.
 * When the model calls this tool, the agent loop terminates and returns
 * a `clarify` outcome to the REPL. The REPL then collects the user's
 * answer and feeds it back as a new user turn.
 */
export const askUserToolDefinition = {
  name: 'askUser',
  description:
    'Pause execution and ask the user a clarifying question. Use this when a requirement is genuinely ambiguous and you cannot proceed confidently. Do NOT use for trivial confirmations. After calling this tool, your turn ends — the user will respond in the next turn.',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user. Be specific and concise.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional: a short list of suggested answers to present as choices.',
      },
    },
    required: ['question'],
  },
};

/**
 * The `finish` tool is how the planner signals it's done with the current
 * user request. This is distinct from `end_turn` (which happens naturally
 * when the model stops emitting tool calls) — `finish` lets the agent give
 * an explicit summary of what was accomplished.
 *
 * We accept BOTH signals (natural end_turn AND explicit finish tool) because
 * different prompting styles yield different behavior.
 */
export const finishToolDefinition = {
  name: 'finish',
  description:
    "Signal that you have completed the user's request. Provide a brief summary (1-2 sentences) of what was done. Call this as your final action.",
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'Brief summary of what was accomplished.',
      },
    },
    required: ['summary'],
  },
};
