// src/session/orchestrator.ts
//
// The orchestrator runs the initial build as three isolated agent phases:
//
//   Phase 1: Architect      — produces a Blueprint
//   Phase 2: Backend Builder — implements convex/* or supabase/* (skipped for stack === 'expo')
//   Phase 3: Frontend Builder — implements theme, components, screens
//
// Critically, each phase runs in its own HTTP request with its own `messages: []`.
// Token cost is paid ONLY for the slice each agent needs.
//
// After the initial build, follow-up turns (/modify, /continue, free-form chat)
// fall back to the single-agent path in agentTurn.ts — the multi-agent pipeline
// is build-only.
//
// The Blueprint is persisted to .bna/blueprint.json and is the canonical
// itself is persisted to .bna/session.json with file-op journal and context
// history. Follow-up turns rehydrate design intent from the blueprint via
// agentTurn's buildBlueprintContext.

import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { runArchitectAgent } from '../agents/architectAgent.js';
import { runBackendAgent } from '../agents/backendAgent.js';
import { runFrontendAgent } from '../agents/frontendAgent.js';
import type { Blueprint } from '../agent/blueprint.js';
import type { Session } from './session.js';
import { emit, isUiActive } from '../ui/events.js';
import { log } from '../utils/logger.js';
import type { TurnOutcome } from './planner.js';

export interface OrchestratorOptions {
  /** Called when the architect needs clarification. Resolve with user's answer. */
  askUser?: (question: string, options?: string[]) => Promise<string>;
}

/**
 * Run the initial build pipeline. Returns a TurnOutcome compatible with the
 * REPL so the existing flow doesn't have to know about the multi-agent split.
 */
export async function runInitialBuildPipeline(
  session: Session,
  prompt: string,
  opts: OrchestratorOptions = {},
): Promise<TurnOutcome> {
  // Mark the start of the build for journaling / UI
  session.beginTurn();

  if (isUiActive()) {
    emit({ type: 'user', text: prompt, ts: Date.now() });
    emit({ type: 'divider' });
  }

  // ── Phase 1: Architect ────────────────────────────────────────────────
  const architectResult = await runArchitectAgent({
    prompt,
    stack: session.stack,
    authToken: session.getAuthToken(),
    askUser: opts.askUser,
  });

  if (!architectResult.ok) {
    return { kind: 'error', message: architectResult.reason };
  }

  const blueprint = architectResult.blueprint;
  await persistBlueprint(session.projectRoot, blueprint);
  session.setBlueprint(blueprint);

  // Print a compact summary of what the architect decided
  printBlueprintSummary(blueprint);

  // ── Phase 2: Backend Builder (skip for Expo-only) ─────────────────────
  if (session.stack !== 'expo') {
    const backendResult = await runBackendAgent({
      blueprint,
      projectRoot: session.projectRoot,
      installManager: session.installManager,
      authToken: session.getAuthToken(),
    });

    if (!backendResult.ok) {
      return {
        kind: 'error',
        message: `Backend phase failed: ${backendResult.reason}`,
      };
    }

    // Use the AMENDED contracts for the frontend — these reflect what was
    // actually built, not what was originally proposed.
    blueprint.apiContracts = backendResult.finalContracts;
    await persistBlueprint(session.projectRoot, blueprint);
    session.setBlueprint(blueprint);

    // Record file ops in the session journal so /undo and /history work
    for (const filePath of backendResult.filesWritten) {
      session.recordOperation('update', filePath);
    }
  } else {
    if (isUiActive()) {
      emit({
        type: 'info',
        text: chalk.dim('Phase 2/3 — backend skipped (Expo-only stack)'),
      });
    }
  }

  // ── Phase 3: Frontend Builder ─────────────────────────────────────────
  const frontendResult = await runFrontendAgent({
    blueprint,
    projectRoot: session.projectRoot,
    installManager: session.installManager,
    authToken: session.getAuthToken(),
  });

  if (!frontendResult.ok) {
    return {
      kind: 'error',
      message: `Frontend phase failed: ${frontendResult.reason}`,
    };
  }

  for (const filePath of frontendResult.filesWritten) {
    session.recordOperation('update', filePath);
  }

  // ── Done ──────────────────────────────────────────────────────────────
  const summary =
    frontendResult.summary ??
    `Built ${blueprint.meta.appName}: ${blueprint.screens.length} screens, ` +
      `${blueprint.dataModel.length} tables, ` +
      `${blueprint.apiContracts.length} APIs.`;

  return { kind: 'complete', summary };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function persistBlueprint(
  projectRoot: string,
  blueprint: Blueprint,
): Promise<void> {
  const dir = path.join(projectRoot, '.bna');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'blueprint.json');
  fs.writeFileSync(file, JSON.stringify(blueprint, null, 2), 'utf-8');
}

export function loadBlueprint(projectRoot: string): Blueprint | null {
  const file = path.join(projectRoot, '.bna', 'blueprint.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Blueprint;
  } catch {
    return null;
  }
}

function printBlueprintSummary(blueprint: Blueprint): void {
  const uiMode = isUiActive();
  const lines = [
    `App: ${blueprint.meta.appName} (${blueprint.meta.slug})`,
    `Theme: ${blueprint.theme.palette}${blueprint.theme.accentHint ? ` · accent: ${blueprint.theme.accentHint}` : ''} · tone: ${blueprint.theme.tone}`,
    `Screens (${blueprint.screens.length}): ${blueprint.screens.map((s) => s.name).join(', ')}`,
  ];
  if (blueprint.dataModel.length > 0) {
    lines.push(
      `Tables (${blueprint.dataModel.length}): ${blueprint.dataModel.map((t) => t.name).join(', ')}`,
    );
  }
  if (blueprint.apiContracts.length > 0) {
    lines.push(`APIs: ${blueprint.apiContracts.length} contracts`);
  }
  if (blueprint.envVars.length > 0) {
    lines.push(`Env vars: ${blueprint.envVars.join(', ')}`);
  }

  if (uiMode) {
    for (const line of lines) emit({ type: 'info', text: chalk.dim(line) });
  } else {
    for (const line of lines) log.info(chalk.dim(line));
  }
}
