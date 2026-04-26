// src/agent/blueprint.ts
//
// The Blueprint is the structured handoff between agents. It's the ONLY
// thing that flows from the Architect to the Backend Builder, and from
// the Backend Builder to the Frontend Builder.
//
// Why this matters:
//   - It serializes to ~2-5KB of JSON for a typical app.
//   - It contains zero narrative or conversation history.
//   - It's deterministically consumable: each downstream agent gets
//     exactly the slice of context it needs, with no extras.
//
// The Backend Builder may amend the contracts as it implements them
// (e.g., add a helper, rename a return field). The orchestrator reads
// the post-build blueprint and passes the AMENDED version to Frontend.

import type { StackId } from '../commands/stacks.js';

// ─── Top-level ────────────────────────────────────────────────────────────

export interface Blueprint {
  /** Schema version for forward compatibility */
  version: 1;

  meta: AppMeta;
  theme: ThemeDirection;
  screens: ScreenSpec[];

  /** Empty array for stack === 'expo' (no backend) */
  dataModel: TableSpec[];

  /** Empty array for stack === 'expo'. Updated by Backend Builder with
   *  whatever was actually implemented. */
  apiContracts: ApiContract[];

  /** Env var NAMES the architect anticipates. Values are collected at
   *  finalization. */
  envVars: string[];

  /** Skills the architect identified up front. Downstream agents may
   *  load more on demand. */
  skillsNeeded: string[];

  /** Free-form notes from the architect explaining tricky decisions.
   *  The Backend Builder consumes this; the Frontend does not. */
  architectNotes?: string;
}

// ─── App metadata ─────────────────────────────────────────────────────────

export interface AppMeta {
  /** Human-friendly name, e.g. "Streaks" */
  appName: string;
  /** Lowercase slug, e.g. "streaks" */
  slug: string;
  /** Reverse-DNS bundle id, e.g. "com.ahmedbna.streaks" */
  bundleId: string;
  /** URL scheme, e.g. "streaks" */
  scheme: string;
  stack: StackId;
  /** One-paragraph description of what the app does */
  description: string;
}

// ─── Theme direction ──────────────────────────────────────────────────────
//
// The architect doesn't pick exact hex codes — it picks a *direction* and
// the frontend agent invents a concrete palette inside theme/colors.ts.
// This keeps the blueprint stable across stylistic iterations.

export interface ThemeDirection {
  /** Coarse categorization to steer the frontend agent away from purple/blue defaults. */
  palette:
    | 'warm-earth'
    | 'cool-clinical'
    | 'monochrome'
    | 'high-contrast'
    | 'pastel'
    | 'jewel-tones'
    | 'forest'
    | 'sunset'
    | 'oceanic'
    | 'custom';

  /** 1-2 sentences explaining why this fits the app's domain. */
  rationale: string;

  /** Optional accent color hint as a name (e.g. "saffron", "moss"). NEVER a hex. */
  accentHint?: string;

  /** Tone of voice for the UI: terse, friendly, formal, playful, etc. */
  tone: 'terse' | 'friendly' | 'formal' | 'playful' | 'authoritative';
}

// ─── Screens ──────────────────────────────────────────────────────────────

export interface ScreenSpec {
  /** Expo Router path under app/, e.g. "(home)/index", "(home)/profile",
   *  "post/[id]". Always relative to app/. */
  route: string;

  /** Human-readable label for the tab/header */
  name: string;

  /** One sentence describing what the user does on this screen */
  purpose: string;

  /** True if this screen is a tab in (home)/_layout.tsx */
  isTab: boolean;

  /** SF Symbol name (iOS) and Feather icon name (Android) for the tab */
  tabIcon?: { ios: string; android: string };

  /** API contract names this screen reads (matches ApiContract.name) */
  reads: string[];

  /** API contract names this screen calls as mutations/actions */
  writes: string[];

  /** components/ui/* this screen relies on. Drives ui-component generation. */
  uiComponents: string[];

  /** Free-form notes for the frontend agent: layout, edge cases, empty states. */
  notes?: string;
}

// ─── Data model ───────────────────────────────────────────────────────────

export interface TableSpec {
  /** Table name, lowercase plural, e.g. "posts", "habits" */
  name: string;

  fields: FieldSpec[];

  /** Indexes, named by_<field>_and_<field>. Do NOT include by_id or by_creation_time. */
  indexes: IndexSpec[];

  /** Supabase only — RLS policies that must ship with the migration */
  rlsPolicies?: RlsPolicy[];

  /** Optional explanation of why this table exists / how it's used */
  notes?: string;
}

export interface FieldSpec {
  name: string;
  /** TypeScript-ish type literal: "string", "number", "boolean", "Id<\"users\">",
   *  "string[]", "{ count: number }", "string | null". The backend agent
   *  translates these into Convex validators or Postgres columns. */
  type: string;
  optional?: boolean;
  /** Whether this field gets its own single-column index */
  index?: boolean;
}

export interface IndexSpec {
  name: string;
  fields: string[];
}

export interface RlsPolicy {
  name: string;
  for: 'select' | 'insert' | 'update' | 'delete';
  /** SQL condition for `using (...)` or `with check (...)` */
  expression: string;
}

// ─── API contracts ────────────────────────────────────────────────────────

export interface ApiContract {
  /** Dotted name matching the actual backend export, e.g. "posts.list",
   *  "auth.signIn", "habits.toggle". For Convex, the dot maps to file.fn;
   *  for Supabase, to api.<file>.<fn>. */
  name: string;

  kind: 'query' | 'mutation' | 'action';

  /** One sentence describing what the function does */
  description: string;

  args: ArgSpec[];

  /** TypeScript return type as a string literal, e.g. "Post[]",
   *  "{ ok: true } | { ok: false; reason: string }", "void", "string". */
  returns: string;

  /** Whether the function rejects unauthenticated callers */
  authRequired: boolean;

  /** Frontend-relevant notes: caching behavior, expected error states */
  notes?: string;
}

export interface ArgSpec {
  name: string;
  /** TypeScript-ish type literal */
  type: string;
  optional?: boolean;
}

// ─── Helpers (used by orchestrator + agents) ──────────────────────────────

export function emptyBlueprint(stack: StackId, slug: string): Blueprint {
  return {
    version: 1,
    meta: {
      appName: slug,
      slug,
      bundleId: `com.ahmedbna.${slug}`,
      scheme: slug,
      stack,
      description: '',
    },
    theme: {
      palette: 'monochrome',
      rationale: '',
      tone: 'friendly',
    },
    screens: [],
    dataModel: [],
    apiContracts: [],
    envVars: [],
    skillsNeeded: [],
  };
}

/** Format the data model as a compact agent-readable section */
export function formatTablesForAgent(tables: TableSpec[]): string {
  if (tables.length === 0) return '(no tables)';
  return tables
    .map((t) => {
      const fields = t.fields
        .map(
          (f) =>
            `    ${f.name}: ${f.type}${f.optional ? ' (optional)' : ''}${
              f.index ? ' [indexed]' : ''
            }`,
        )
        .join('\n');
      const indexes =
        t.indexes.length > 0
          ? '\n  indexes:\n' +
            t.indexes
              .map((i) => `    ${i.name} on [${i.fields.join(', ')}]`)
              .join('\n')
          : '';
      const rls =
        t.rlsPolicies && t.rlsPolicies.length > 0
          ? '\n  rls:\n' +
            t.rlsPolicies
              .map((p) => `    ${p.name} (${p.for}): ${p.expression}`)
              .join('\n')
          : '';
      const notes = t.notes ? `\n  notes: ${t.notes}` : '';
      return `${t.name}:\n${fields}${indexes}${rls}${notes}`;
    })
    .join('\n\n');
}

/** Format API contracts as a compact agent-readable section */
export function formatContractsForAgent(contracts: ApiContract[]): string {
  if (contracts.length === 0) return '(no api contracts)';
  return contracts
    .map((c) => {
      const args =
        c.args.length === 0
          ? '()'
          : '({ ' +
            c.args
              .map((a) => `${a.name}${a.optional ? '?' : ''}: ${a.type}`)
              .join(', ') +
            ' })';
      const auth = c.authRequired ? ' [auth]' : '';
      const notes = c.notes ? `\n    // ${c.notes}` : '';
      return `${c.kind} ${c.name}${args}: ${c.returns}${auth}${notes}\n    // ${c.description}`;
    })
    .join('\n\n');
}

/** Format screens for the frontend agent */
export function formatScreensForAgent(screens: ScreenSpec[]): string {
  if (screens.length === 0) return '(no screens — should never happen)';
  return screens
    .map((s) => {
      const tab = s.isTab ? ' [TAB]' : '';
      const icon = s.tabIcon
        ? ` (icon: ios=${s.tabIcon.ios}, android=${s.tabIcon.android})`
        : '';
      const reads = s.reads.length > 0 ? `\n  reads: ${s.reads.join(', ')}` : '';
      const writes =
        s.writes.length > 0 ? `\n  writes: ${s.writes.join(', ')}` : '';
      const ui =
        s.uiComponents.length > 0
          ? `\n  ui: ${s.uiComponents.join(', ')}`
          : '';
      const notes = s.notes ? `\n  notes: ${s.notes}` : '';
      return `${s.route}${tab}${icon} — ${s.name}\n  purpose: ${s.purpose}${reads}${writes}${ui}${notes}`;
    })
    .join('\n\n');
}
