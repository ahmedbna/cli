// src/agent/tools/skills.ts
// Skill resolver — reads documentation from the skills/ directory at runtime.
// Skills are shipped as plain markdown files alongside the bundle (like templates/).
// This replaces the old approach of embedding docs as TypeScript string exports.

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

// ─── Available skills and their topics ───────────────────────────────────────

export const SKILL_REGISTRY: Record<string, { description: string; topics: string[] }> = {
  convex: {
    description: 'Convex backend features: file storage, search, pagination, HTTP actions, scheduling, Node.js actions, types, function calling, advanced queries/mutations, presence',
    topics: [
      'file-storage',
      'full-text-search',
      'pagination',
      'http-actions',
      'scheduling',
      'node-actions',
      'types',
      'function-calling',
      'advanced-queries',
      'advanced-mutations',
      'presence',
    ],
  },
  expo: {
    description: 'Expo/React Native features: dev builds, EAS builds, routing, image/media, animations, haptics/gestures',
    topics: [
      'dev-build',
      'eas-build',
      'routing',
      'image-media',
      'animations',
      'haptics-gestures',
    ],
  },
};

export const SKILL_NAMES = Object.keys(SKILL_REGISTRY);

export const ALL_TOPICS = Object.entries(SKILL_REGISTRY).flatMap(
  ([skill, { topics }]) => topics.map((t) => `${skill}/${t}`),
);

// ─── Resolve the skills directory ────────────────────────────────────────────

let cachedSkillsDir: string | null = null;

/**
 * Find the skills/ directory relative to the package root.
 * Works both in development (running from repo root) and when installed as a package.
 */
function resolveSkillsDir(): string {
  if (cachedSkillsDir) return cachedSkillsDir;

  // Walk up from the current file location to find skills/
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(candidate)) {
      cachedSkillsDir = candidate;
      return candidate;
    }
    dir = path.dirname(dir);
  }

  // Try from cwd (for development)
  const cwdCandidate = path.join(process.cwd(), 'skills');
  if (fs.existsSync(cwdCandidate)) {
    cachedSkillsDir = cwdCandidate;
    return cwdCandidate;
  }

  throw new Error(
    'Skills directory not found. Expected at <package>/skills/. ' +
      'Ensure the skills/ directory is included in your npm package.',
  );
}

// ─── Read skill files ────────────────────────────────────────────────────────

/**
 * Read the SKILL.md overview for a given skill.
 */
export function readSkillOverview(skillName: string): string {
  const skillsDir = resolveSkillsDir();
  const skillPath = path.join(skillsDir, skillName, 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    return `Error: Skill "${skillName}" not found. Available skills: ${SKILL_NAMES.join(', ')}`;
  }

  return fs.readFileSync(skillPath, 'utf-8');
}

/**
 * Read specific reference docs for a skill.
 * Returns concatenated content of all requested topics.
 */
export function readSkillReferences(skillName: string, topics: string[]): string {
  const skillsDir = resolveSkillsDir();
  const refsDir = path.join(skillsDir, skillName, 'references');
  const results: string[] = [];

  const registry = SKILL_REGISTRY[skillName];
  if (!registry) {
    return `Error: Unknown skill "${skillName}". Available skills: ${SKILL_NAMES.join(', ')}`;
  }

  for (const topic of topics) {
    if (!registry.topics.includes(topic)) {
      results.push(
        `Unknown topic "${topic}" for skill "${skillName}". ` +
          `Valid topics: ${registry.topics.join(', ')}`,
      );
      continue;
    }

    const refPath = path.join(refsDir, `${topic}.md`);
    if (!fs.existsSync(refPath)) {
      results.push(`Error: Reference file not found: ${skillName}/references/${topic}.md`);
      continue;
    }

    results.push(fs.readFileSync(refPath, 'utf-8'));
  }

  return results.join('\n\n---\n\n');
}

/**
 * Main executor for the lookupDocs tool.
 * Reads skill overview + specific topic references.
 */
export function executeLookupDocs(args: {
  skill: string;
  topics: string[];
}): string {
  const { skill, topics } = args;

  // If no specific topics, return the SKILL.md overview
  if (!topics || topics.length === 0) {
    return readSkillOverview(skill);
  }

  // Return the specific reference docs
  return readSkillReferences(skill, topics);
}

/**
 * List all available skills and their topics (for agent discovery).
 */
export function listAvailableSkills(): string {
  const lines: string[] = ['# Available Documentation Skills\n'];

  for (const [name, { description, topics }] of Object.entries(SKILL_REGISTRY)) {
    lines.push(`## ${name}`);
    lines.push(description);
    lines.push(`Topics: ${topics.join(', ')}\n`);
  }

  return lines.join('\n');
}
