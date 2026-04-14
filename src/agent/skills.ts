// src/agent/skills.ts
// Skill resolver — auto-discovers individual skill folders at runtime.
//
// Each skill is a self-contained folder with its own SKILL.md:
//   skills/convex-file-storage/SKILL.md
//   skills/expo-animations/SKILL.md
//   etc.
//
// The agent loads ONLY the specific skill it needs, saving tokens.
// No more two-step "overview + reference" loading.

import fs from 'fs';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillMetadata {
  name: string;
  description: string;
  /** Absolute path to the skill directory */
  dirPath: string;
}

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

// ─── Discover skills ─────────────────────────────────────────────────────────

let cachedRegistry: Map<string, SkillMetadata> | null = null;

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts `name` and `description` fields.
 */
function parseFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';

  if (!name || !description) return null;
  return { name, description };
}

/**
 * Scan the skills/ directory and build a registry of all available skills.
 * Each subdirectory with a SKILL.md is registered.
 */
function discoverSkills(): Map<string, SkillMetadata> {
  if (cachedRegistry) return cachedRegistry;

  const skillsDir = resolveSkillsDir();
  const registry = new Map<string, SkillMetadata>();

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const meta = parseFrontmatter(content);
    if (!meta) continue;

    registry.set(meta.name, {
      name: meta.name,
      description: meta.description,
      dirPath: path.join(skillsDir, entry.name),
    });
  }

  cachedRegistry = registry;
  return registry;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get all registered skill names.
 */
export function getSkillNames(): string[] {
  return Array.from(discoverSkills().keys());
}

/**
 * Get metadata for all skills (name + description).
 * Used to build the system prompt so the agent knows what's available.
 */
export function getSkillMetadata(): SkillMetadata[] {
  return Array.from(discoverSkills().values());
}

/**
 * Read the full SKILL.md content for a specific skill.
 * This is the main executor — the agent calls this to load a skill's instructions.
 * Strips YAML frontmatter so the agent only gets the instruction body.
 */
export function readSkill(skillName: string): string {
  const registry = discoverSkills();
  const skill = registry.get(skillName);

  if (!skill) {
    const available = getSkillNames().join(', ');
    return `Error: Unknown skill "${skillName}". Available skills: ${available}`;
  }

  const skillMdPath = path.join(skill.dirPath, 'SKILL.md');
  const content = fs.readFileSync(skillMdPath, 'utf-8');

  // Strip YAML frontmatter — the agent only needs the instructions body
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
  return body.trim();
}

/**
 * Read multiple skills at once. More efficient for related features.
 */
export function readSkills(skillNames: string[]): string {
  const results: string[] = [];

  for (const name of skillNames) {
    const content = readSkill(name);
    results.push(`## Skill: ${name}\n\n${content}`);
  }

  return results.join('\n\n---\n\n');
}

/**
 * Generate a compact summary of all available skills for the system prompt.
 * Only includes name + description (Level 1 metadata — always loaded, ~100 tokens per skill).
 */
export function generateSkillsSummary(): string {
  const skills = getSkillMetadata();

  if (skills.length === 0) {
    return '(No skills available)';
  }

  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);

  return lines.join('\n');
}
