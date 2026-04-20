// src/agent/prompts.ts
// System prompt composer for the BNA CLI agent.
//
// The prompt is assembled from three layers:
//   - shared/      — stack-agnostic pieces (role, CLI mode, formatting, output, secrets, example data)
//   - frontend/<tech>/  — frontend-specific guidelines (expo, swift, …)
//   - backend/<tech>/   — backend-specific guidelines (convex, supabase, …)
//
// The stack id (e.g. "expo-convex") is parsed into a frontend + optional
// backend, and the matching guideline modules are loaded.

import { stripIndents } from '../utils/stripIndent.js';

import { roleSystemPrompt } from './prompts/shared/role.js';
import { cliSystemPrompt } from './prompts/shared/cliMode.js';
import { formattingInstructions } from './prompts/shared/formatting.js';
import { outputInstructions } from './prompts/shared/output.js';
import { secretsInstructions } from './prompts/shared/secrets.js';
import { exampleDataInstructions } from './prompts/shared/exampleData.js';

import { expoGuidelines } from './prompts/frontend/expo/guidelines.js';
import { swiftGuidelines } from './prompts/frontend/swift/guidelines.js';
import { convexGuidelines } from './prompts/backend/convex/guidelines.js';
import { supabaseGuidelines } from './prompts/backend/supabase/guidelines.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PromptFrontend = 'expo' | 'swift';
export type PromptBackend = 'convex' | 'supabase' | null;

export interface SystemPromptOptions {
  stack: 'expo' | 'expo-convex';
}

export type StackId = SystemPromptOptions['stack'];

// ─── Stack parsing ───────────────────────────────────────────────────────────

function parseStack(stack: StackId): {
  frontend: PromptFrontend;
  backend: PromptBackend;
} {
  const [frontend, backend] = stack.split('-');
  return {
    frontend: frontend as PromptFrontend,
    backend: ((backend ?? null) as PromptBackend) || null,
  };
}

// ─── Technology dispatch ─────────────────────────────────────────────────────

function frontendGuidelines(frontend: PromptFrontend): string {
  switch (frontend) {
    case 'expo':
      return expoGuidelines();
    case 'swift':
      return swiftGuidelines();
  }
}

function backendGuidelines(backend: PromptBackend): string {
  switch (backend) {
    case 'convex':
      return convexGuidelines();
    case 'supabase':
      return supabaseGuidelines();
    case null:
      return '';
  }
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export function generalSystemPrompt(options: SystemPromptOptions): string {
  const { stack } = options;
  const { frontend, backend } = parseStack(stack);

  return stripIndents`
  ${roleSystemPrompt({ frontend, backend })}
  ${cliSystemPrompt({ stack, frontend, backend })}
  ${frontendGuidelines(frontend)}
  ${backendGuidelines(backend)}
  ${exampleDataInstructions({ backend })}
  ${secretsInstructions({ backend })}
  ${formattingInstructions(options)}
  ${outputInstructions({ frontend, backend })}
  `;
}
