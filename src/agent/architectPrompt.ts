// src/agent/architectPrompt.ts
//
// Loads the architect system prompt from disk. Each stack has its own
// architect prompt because data-modeling rules differ (Convex validators
// vs Supabase RLS, etc).

import fs from 'fs';
import path from 'path';
import type { StackId } from '../commands/stacks.js';

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
  throw new Error('Prompts directory not found.');
}

export function architectSystemPrompt(stack: StackId): string {
  const file = path.join(resolvePromptsDir(), 'architect', `${stack}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`Architect prompt not found for stack: ${stack}`);
  }
  return fs.readFileSync(file, 'utf-8').trim();
}

export function backendSystemPrompt(stack: StackId): string {
  const file = path.join(resolvePromptsDir(), 'backend', `${stack}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`Backend prompt not found for stack: ${stack}`);
  }
  return fs.readFileSync(file, 'utf-8').trim();
}

export function frontendSystemPrompt(stack: StackId): string {
  const file = path.join(resolvePromptsDir(), 'frontend', `${stack}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`Frontend prompt not found for stack: ${stack}`);
  }
  return fs.readFileSync(file, 'utf-8').trim();
}
