// src/agent/prompts.ts
// System prompt composer for the BNA CLI agent.
//
// The system prompt is assembled from markdown fragments in the top-level
// `prompts/` directory. The stack id (e.g. `expo-convex`) selects which
// per-stack md files are loaded. Stack-agnostic pieces (formatting) are
// loaded unconditionally.
//
// Layout:
//   prompts/frontend/<fe>.md                — frontend guidelines
//   prompts/backend/<be>.md                 — backend guidelines
//   prompts/system/role/<stack>.md          — opening role statement
//   prompts/system/cli/<stack>.md           — CLI mode + tools + workflow
//   prompts/system/example-data/<be>.md     — example data instructions
//   prompts/system/secrets/<be>.md          — secrets handling
//   prompts/system/formatting.md            — formatting rules
//   prompts/system/output/<stack>.md        — output instructions
//
// The cli md file may contain a `{{SKILLS_CATALOG}}` placeholder which is
// substituted at load time with the runtime-generated skills summary.

import fs from 'fs';
import path from 'path';
import { generateSkillsSummary } from './skills.js';

export type PromptFrontend = 'expo' | 'swift';
export type PromptBackend = 'convex' | 'supabase' | null;

export interface SystemPromptOptions {
  stack: 'expo' | 'expo-convex';
}

export type StackId = SystemPromptOptions['stack'];

// ─── Resolve the prompts directory ───────────────────────────────────────────

let cachedPromptsDir: string | null = null;

function resolvePromptsDir(): string {
  if (cachedPromptsDir) return cachedPromptsDir;

  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'prompts');
    if (fs.existsSync(candidate)) {
      cachedPromptsDir = candidate;
      return candidate;
    }
    dir = path.dirname(dir);
  }

  const cwdCandidate = path.join(process.cwd(), 'prompts');
  if (fs.existsSync(cwdCandidate)) {
    cachedPromptsDir = cwdCandidate;
    return cwdCandidate;
  }

  throw new Error(
    'Prompts directory not found. Expected at <package>/prompts/.',
  );
}

function loadMd(relativePath: string): string {
  const full = path.join(resolvePromptsDir(), relativePath);
  if (!fs.existsSync(full)) return '';
  return fs.readFileSync(full, 'utf-8').trim();
}

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

// ─── Assembly ────────────────────────────────────────────────────────────────

export function generalSystemPrompt(options: SystemPromptOptions): string {
  const { stack } = options;
  const { frontend, backend } = parseStack(stack);
  const backendKey = backend ?? 'none';

  const cli = loadMd(`system/cli/${stack}.md`).replace(
    '{{SKILLS_CATALOG}}',
    generateSkillsSummary(stack),
  );

  const sections = [
    loadMd(`system/role/${stack}.md`),
    cli,
    loadMd(`frontend/${frontend}.md`),
    backend ? loadMd(`backend/${backend}.md`) : '',
    loadMd(`system/example-data/${backendKey}.md`),
    loadMd(`system/secrets/${backendKey}.md`),
    loadMd('system/formatting.md'),
    loadMd(`system/output/${stack}.md`),
  ];

  return sections.filter(Boolean).join('\n\n');
}
