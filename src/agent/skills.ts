// src/agent/skills.ts
// Skill resolver — auto-discovers individual skill folders at runtime.
//
// Skills are grouped by the technology they target. The directory layout is:
//
//   skills/convex/convex-file-storage/SKILL.md
//   skills/convex/convex-pagination/SKILL.md
//   skills/expo/expo-animations/SKILL.md
//   skills/expo/expo-routing/SKILL.md
//   skills/supabase/...
//
// The parent folder (convex, expo, supabase) is the skill's `tech` tag.
// The agent only sees skills that match the technologies in the selected
// stack (e.g. `expo-convex` → expo + convex skills only).

import fs from 'fs';
import path from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export type StackId = 'expo' | 'expo-convex';
export type Tech = string;

export interface SkillMetadata {
  name: string;
  description: string;
  /** Technology bucket this skill belongs to (parent folder name). */
  tech: Tech;
  /** Absolute path to the skill directory */
  dirPath: string;
}

// ─── Resolve the skills directory ────────────────────────────────────────────

let cachedSkillsDir: string | null = null;

function resolveSkillsDir(): string {
  if (cachedSkillsDir) return cachedSkillsDir;

  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(candidate)) {
      cachedSkillsDir = candidate;
      return candidate;
    }
    dir = path.dirname(dir);
  }

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

// ─── Stack → tech mapping ────────────────────────────────────────────────────

/**
 * Which tech buckets does a given stack include?
 * The stack id is a frontend-backend combo; we split on `-` to get the techs.
 */
export function techsForStack(stack: StackId): Tech[] {
  return stack.split('-');
}

// ─── Discover skills ─────────────────────────────────────────────────────────

let cachedRegistry: Map<string, SkillMetadata> | null = null;

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
 * Scan skills/<tech>/<skill>/SKILL.md and build a registry.
 * Falls back to the legacy flat layout skills/<skill>/SKILL.md so older
 * installations keep working during migration.
 */
function discoverSkills(): Map<string, SkillMetadata> {
  if (cachedRegistry) return cachedRegistry;

  const skillsDir = resolveSkillsDir();
  const registry = new Map<string, SkillMetadata>();

  const topEntries = fs.readdirSync(skillsDir, { withFileTypes: true });

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    const topPath = path.join(skillsDir, top.name);

    // Legacy flat layout: skills/<skill>/SKILL.md
    const flatSkillMd = path.join(topPath, 'SKILL.md');
    if (fs.existsSync(flatSkillMd)) {
      const content = fs.readFileSync(flatSkillMd, 'utf-8');
      const meta = parseFrontmatter(content);
      if (meta) {
        registry.set(meta.name, {
          name: meta.name,
          description: meta.description,
          tech: inferTechFromName(meta.name),
          dirPath: topPath,
        });
      }
      continue;
    }

    // Nested layout: skills/<tech>/<skill>/SKILL.md
    const tech = top.name;
    const innerEntries = fs.readdirSync(topPath, { withFileTypes: true });
    for (const inner of innerEntries) {
      if (!inner.isDirectory()) continue;
      const skillMd = path.join(topPath, inner.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, 'utf-8');
      const meta = parseFrontmatter(content);
      if (!meta) continue;

      registry.set(meta.name, {
        name: meta.name,
        description: meta.description,
        tech,
        dirPath: path.join(topPath, inner.name),
      });
    }
  }

  cachedRegistry = registry;
  return registry;
}

/**
 * Fallback for legacy flat-layout skills whose name is prefixed with the tech
 * (e.g. `convex-file-storage`). If we can't infer, mark as `misc`.
 */
function inferTechFromName(name: string): Tech {
  const prefix = name.split('-')[0];
  if (!prefix) return 'misc';
  return prefix;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getSkillNames(): string[] {
  return Array.from(discoverSkills().keys());
}

export function getSkillMetadata(): SkillMetadata[] {
  return Array.from(discoverSkills().values());
}

/**
 * Skills available for a given stack — filtered to the stack's tech buckets.
 */
export function getSkillMetadataForStack(stack: StackId): SkillMetadata[] {
  const techs = new Set(techsForStack(stack));
  return getSkillMetadata().filter((s) => techs.has(s.tech));
}

export function getSkillNamesForStack(stack: StackId): string[] {
  return getSkillMetadataForStack(stack).map((s) => s.name);
}

/**
 * Read the full SKILL.md content for a specific skill.
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
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
  return body.trim();
}

export function readSkills(skillNames: string[]): string {
  const results: string[] = [];
  for (const name of skillNames) {
    const content = readSkill(name);
    results.push(`## Skill: ${name}\n\n${content}`);
  }
  return results.join('\n\n---\n\n');
}

/**
 * Compact skills catalog for the system prompt, grouped by tech and filtered
 * to the stack the user selected. Only includes name + description.
 */
export function generateSkillsSummary(stack: StackId): string {
  const skills = getSkillMetadataForStack(stack);

  if (skills.length === 0) {
    return '(No skills available for this stack)';
  }

  const byTech = new Map<Tech, SkillMetadata[]>();
  for (const s of skills) {
    const bucket = byTech.get(s.tech) ?? [];
    bucket.push(s);
    byTech.set(s.tech, bucket);
  }

  const sections: string[] = [];
  for (const tech of techsForStack(stack)) {
    const bucket = byTech.get(tech);
    if (!bucket || bucket.length === 0) continue;
    const lines = bucket.map((s) => `- **${s.name}**: ${s.description}`);
    sections.push(`#### ${tech}\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
