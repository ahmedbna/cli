// src/agent/prompts.ts
// System prompt composer for the BNA CLI agent.
//
// Each stack has a single self-contained template at
// `prompts/template/<stack>.md`. The `{{SKILLS_CATALOG}}` placeholder is
// substituted at load time with the runtime-generated skills summary.

import fs from 'fs';
import path from 'path';
import { generateSkillsSummary } from './skills.js';

export interface SystemPromptOptions {
  stack: 'expo' | 'expo-convex' | 'expo-supabase';
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
  if (!fs.existsSync(full)) {
    throw new Error(`Prompt template not found: ${relativePath}`);
  }
  return fs.readFileSync(full, 'utf-8').trim();
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export function generalSystemPrompt(options: SystemPromptOptions): string {
  const { stack } = options;
  return loadMd(`template/${stack}.md`).replace(
    '{{SKILLS_CATALOG}}',
    generateSkillsSummary(stack),
  );
}
