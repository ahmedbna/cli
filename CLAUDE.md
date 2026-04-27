# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

BNA CLI is an AI-powered CLI tool that generates full-stack mobile apps (Expo + Convex) from natural language prompts. It uses Claude (via Anthropic SDK) as a three-phase agentic pipeline (Architect → Backend Builder → Frontend Builder) for initial builds, then falls back to a single-agent loop for follow-up edits.

## Commands

```bash
# Build the CLI
npm run build        # bundles via esbuild → dist/index.js
npm run dev          # build + run immediately

# Run locally
node dist/index.js
npm start

# Main CLI commands (after install)
bna login
bna                                                         # default: resume session in cwd, else scaffold
bna init --name my-app --frontend expo --backend convex --prompt "describe app"
bna --skills pptx,xlsx     # opt-in Agent Skills
bna --no-install --no-run  # skip post-gen steps
bna credits
bna config --show
```

No test suite or linter is configured in this repo. Running `bna` with no subcommand calls `generateCommand()` (the build/REPL entry); `bna init` is an explicit alias for the same flow.

## Architecture

### Entry & Command Routing

`src/index.ts` — Commander.js router. Commands: `login`, `logout`, `init`, `credits`, `config`, plus `stacks.ts` helpers for stack selection. Running bare `bna` (no subcommand) executes `generateCommand` directly — same entry as `bna init`. Build flags (`--prompt`, `--name`, `--frontend`, `--backend`, `--skills`, `--no-install`, `--no-run`) are accepted on both the root command and `init`.

### Build Pipeline (`src/commands/build.ts`)

Context-aware entry logic:

- `--name` given, or empty directory → scaffold new project + run REPL
- Existing directory with `.bna/session.json` or `.bna/blueprint.json` → resume saved session (blueprint-only falls through to a fresh chat session over the existing project)
- Existing BNA-like project (has `package.json` + `app/`) but no `.bna/` state → prompt: fresh session or new subdirectory
- Other non-empty directory → prompt for project name

After context resolution:

1. Auth check + credits validation
2. Copy template from `templates/expo-convex/` to target directory
3. Start background `npm install` (InstallManager) unless `--no-install`
4. Create Session → launch REPL
5. First agent turn fires automatically with the user's prompt (routes to orchestrator for initial builds)
6. After first turn: interactive prompt to run the finalization pipeline (5 steps: Convex init → TypeScript check + autofix → git init → Convex Auth → expo run:ios/android). `--no-run` skips only the final simulator launch (step 5); the rest of finalization still runs if the user confirms.

### Multi-Agent Build Pipeline

The initial build runs as three isolated phases via `src/session/orchestrator.ts`. Each phase gets its own fresh HTTP request — no conversation history crosses phase boundaries.

```text
User prompt → orchestrator.runInitialBuildPipeline
  ├── Phase 1: architectAgent    (1-8 rounds, no FS access, calls proposeBlueprint)
  │   └── Blueprint persisted to .bna/blueprint.json
  ├── Wait for background `npm install` to finish (started in build.ts)
  ├── Phase 2: backendAgent      (5-15 rounds, writes convex/* or supabase/*)
  │   └── Reports finalContracts via finishBackend — may amend architect's signatures
  │   └── Blueprint updated with amended contracts in .bna/blueprint.json
  ├── Backend setup (session/backendSetup.ts):
  │     · Convex: `npx convex dev --once` → `npx @convex-dev/auth` → prompt for
  │       env vars → `npx convex env set …` → redeploy → `npx convex dev` (bg)
  │     · Supabase: prompt user for Project URL + anon key + any queued env
  │       vars → write all values to .env.local (no Docker required)
  │   └── session.setBackendDeployed(true) so /finalize skips these steps later
  └── Phase 3: frontendAgent     (10-25 rounds, writes theme/components/screens)
      └── Receives FINAL contracts from Phase 2, calls finish()
```

**Blueprint** (`src/agent/blueprint.ts`) — The structured JSON handoff between phases. Contains: `meta` (appName, slug, bundleId), `theme` (palette + tone), `screens` (routes, tabs, reads/writes), `dataModel` (tables, fields, indexes, RLS policies), `apiContracts` (function signatures), `envVars`, `skillsNeeded`, and optional `architectNotes`. Serializes to ~2–5KB. The Backend Builder amends `apiContracts` to reflect what was actually implemented; the orchestrator re-persists and passes the amended version to the Frontend Builder.

**After initial build**, all follow-up turns (`/modify`, free-form chat, `/continue`) go through the single-agent loop in `agentTurn.ts`. The blueprint is injected as context on the first follow-up turn so the agent understands the existing design without re-reading every file.

**Resumed sessions**: `session.hasBuilt()` returns true if a blueprint exists. The REPL calls the orchestrator only when `!session.hasBuilt()`, so resuming a saved session goes straight to the single-agent follow-up path.

#### Agent tool access by phase

| Phase     | Can write files | lookupDocs | askUser  | finish tool        |
| --------- | --------------- | ---------- | -------- | ------------------ |
| Architect | No              | Yes        | Yes (1x) | `proposeBlueprint` |
| Backend   | Yes (convex/\*) | Yes        | No       | `finishBackend`    |
| Frontend  | Yes (full)      | Yes        | No       | `finish`           |

#### Adding a new stack to the pipeline

Add `prompts/architect/<stack>.md`, `prompts/backend/<stack>.md`, and `prompts/frontend/<stack>.md` alongside `templates/<stack>/` and register the stack id in `stacks.ts`.

### Session & REPL (`src/session/`)

- `session.ts` — Holds conversation history, file operation journal (for `/undo`), env vars, turn count, and the `Blueprint` object (`getBlueprint()` / `setBlueprint()`). Serializes to `.bna/session.json`; blueprint is separately persisted to `.bna/blueprint.json` and restored on load. `ContextManager` is initialized with `keepRecentRounds: 3`, `toolResultMaxChars: 400`, `createFileContentMaxChars: 200`, `viewDedupWindow: 4`.
- `repl.ts` — Interactive readline loop. First turn routes to `runInitialBuildPipeline` (orchestrator); subsequent turns call `runAgentTurn`. Ctrl-C once interrupts the running turn; Ctrl-C twice within 2s exits. To resume a saved session, run `bna build` in (or with `--name` pointing to) the project directory.
- `agentTurn.ts` — Single-agent loop used for **follow-up turns only**. Streams SSE from `/cli/chat` via `apiClient.fetchStreamWithRetry`, parses tool calls, executes tools, loops until `end_turn` or `askUser`/`finish` (hard cap: `MAX_ROUNDS_PER_TURN = 30`). Injects the blueprint as additional context on the first follow-up turn via `buildBlueprintContext`. HTTP 401 triggers token refresh + retry; HTTP 402 means insufficient credits. Warns the user at round 20 (`LONG_TURN_THRESHOLD`) if a turn is running long.
- `orchestrator.ts` — Wires the three build phases together. Persists/reloads the blueprint between phases. Returns a `TurnOutcome` so `repl.ts` doesn't need to know it ran three agents.
- `planner.ts` — Defines `TurnOutcome` (`complete | clarify | interrupted | error`) and the `askUser` / `finish` tool definitions.

Full slash-command list (`/help` shows these at runtime):

| Command          | Description                                                                      |
| ---------------- | -------------------------------------------------------------------------------- |
| `/help`          | Show command list                                                                |
| `/status`        | Show session state and recent file changes                                       |
| `/history`       | Show last 20 file operations                                                     |
| `/undo`          | Revert the most recent file operation                                            |
| `/modify <desc>` | Ask the agent to modify the app                                                  |
| `/continue`      | Ask the agent to pick up from where it left off                                  |
| `/finalize`      | Run the finalization pipeline (Convex init → tsc → git → Convex Auth → expo run) |
| `/clear`         | Clear the screen                                                                 |
| `/exit`          | Save the session and quit                                                        |

### Agent Core (`src/agent/`)

- `agent.ts` — Headless agent loop (`runAgent`), used **only** by `tsCheck.ts` for TypeScript autofix during finalization. Not called during the interactive REPL. Uses `apiClient.fetchStreamWithRetry` like the other agents.
- `tools.ts` — 12 tool definitions (Zod schemas) + executors: `createFile`, `editFile`, `deleteFile`, `renameFile`, `viewFile`, `readMultipleFiles`, `listDirectory`, `searchFiles`, `runCommand`, `lookupDocs`, `addEnvironmentVariables`, `checkDependencies`. (`askUser` / `finish` live in `session/planner.ts`.) `editFile` requires `oldText` to appear exactly once (under 1024 chars). `runCommand` default timeout is 180 s; npm-family commands serialize behind InstallManager. `addEnvironmentVariables` only queues names — values are collected interactively at finalization.
- `blueprint.ts` — `Blueprint` interface + Zod-validated sub-schemas. Also exports `formatTablesForAgent`, `formatContractsForAgent`, `formatScreensForAgent` helpers used to build agent messages.
- `architectPrompt.ts` — Loads `prompts/architect/<stack>.md`, `prompts/backend/<stack>.md`, `prompts/frontend/<stack>.md` at runtime.
- `contextManager.ts` — Manages conversation window; deduplicates recent `viewFile` calls.
- `skills.ts` — Auto-discovers skills from `prompts/skills/<category>/<skill>/SKILL.md` on demand via `lookupDocs`.
- `prompts.ts` — Loads `prompts/template/<stack>.md` for follow-up single-agent turns. Each template is fully self-contained.

### Specialized Agents (`src/agents/`)

- `architectAgent.ts` — Phase 1. No FS tools. Max 8 rounds. Uses Zod to validate the `proposeBlueprint` payload before accepting it; sends validation errors back to the model for self-correction. One `askUser` clarification permitted.
- `backendAgent.ts` — Phase 2. Restricted tool set (no `searchFiles` / `listDirectory` / `askUser`). Max 25 rounds. Must call `finishBackend` with the actual implemented contracts; calling `end_turn` without it is treated as a failure.
- `frontendAgent.ts` — Phase 3. Full tool set (no `askUser`). Max 30 rounds. Calling `finish` or natural `end_turn` both count as success.

### Key Patterns

- **Phase isolation**: Each agent in the build pipeline runs a fresh `messages: []` array. Token cost is paid only for the slice each agent needs (~130–285K total vs ~700K–1M for the old single-agent approach).
- **Blueprint as handoff**: The only thing flowing between phases is the ~2–5KB Blueprint JSON. No conversation history crosses phase boundaries.
- **Backend signature drift**: The Backend Builder reports its _actual_ implemented contracts via `finishBackend`. The orchestrator re-persists the amended blueprint so the Frontend Builder and future follow-up turns see the real signatures.
- **Streaming SSE**: All three build agents and the follow-up agent stream SSE from `/cli/chat`. The architect collects full blocks before processing (no live streaming UX needed); backend suppresses text streaming; frontend streams assistant text live.
- **Parallel install**: `installManager.ts` runs `npm install` in the background; `runCommand` auto-waits if install is still running.
- **File journal**: Every file mutation is journaled in the session → `/undo` replays in reverse.
- **Skill system**: `prompts/skills/{convex,expo,supabase}/<skill>/SKILL.md`. Drop a new folder to add a skill; it's auto-discovered via `lookupDocs`.
- **Session persistence**: `.bna/session.json` + `.bna/blueprint.json` inside the generated project allow resuming across CLI restarts.
- **Clarification loop**: the `askUser` tool lets the model pause a turn for a user question. The Architect may call it once; Backend and Frontend agents cannot. Do not add ad-hoc clarification prompts elsewhere.

### UI Layer (`src/ui/`)

The terminal UI is built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs). It activates when a TTY is detected; non-TTY / CI falls back to the legacy spinner path.

- `events.ts` — `uiBus` EventEmitter + `UiEvent` union type. Agent/tool code calls `emit(event)`; Ink components subscribe via `on(fn)`. `setUiActive(true)` gates all emissions.
- `App.tsx` — Root Ink component. **Static/Live split**: finalized items go into `<Static>` (rendered once, scrollback-safe); in-flight tool calls and streaming assistant text live in a re-rendering "live region" below. State is managed by a single `reducer(state, UiEvent)`.
- `toolAdapter.ts` — `createToolUi(kind, label)` returns a `ToolUi` interface whose methods (`progress`, `update`, `succeed`, `fail`) dispatch to either the event bus or the legacy Ora spinner. Tool executors must always go through this, never call `emit()` / `startSpinner()` directly.
- `theme.ts` — Brand color palette (`accent: '#FAD40B'` BNA yellow) and the thinking spinner verb rotation.
- `components/` — `Lines.tsx`, `ToolLine.tsx`, `Thinking.tsx` (round + token counter), `Input.tsx`, `SlashPalette.tsx`, `ClarifyPicker.tsx`.

### Utils (`src/utils/`)

| File                | Purpose                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiClient.ts`      | Shared HTTP client for `/cli/chat`: `fetchStream`, `fetchStreamWithRetry` (502/503/504, 3 attempts, exp backoff), `extractErrorMessage` (strips HTML from proxies). All four agents import from here. |
| `auth.ts`           | OAuth token storage + refresh                                                                                                                                                                         |
| `store.ts`          | Conf-based persistent config (`~/.config/bna-cli/`)                                                                                                                                                   |
| `credits.ts`        | Credit balance helpers used by `bna credits` and pre-turn gating                                                                                                                                      |
| `installManager.ts` | Background npm orchestration with streaming output                                                                                                                                                    |
| `tsCheck.ts`        | TypeScript validation + autofix after generation                                                                                                                                                      |
| `gitInit.ts`        | Git repo initialization post-build                                                                                                                                                                    |
| `logger.ts`         | Chalk-based pretty terminal output                                                                                                                                                                    |
| `liveSpinner.ts`    | Ora-based reusable spinners                                                                                                                                                                           |
| `shell.ts`          | Terminal output cleaning / ANSI                                                                                                                                                                       |

### Templates

Three active templates under `templates/`: `expo-convex/`, `expo-supabase/`, and `expo/` (no backend). All use Expo Router with the same component/theme structure. Modifying a template affects every newly generated app for that stack. To add a new stack: drop a `templates/<stack>/` directory, add prompt files under `prompts/architect/`, `prompts/backend/`, `prompts/frontend/`, and `prompts/template/` for that stack id, then register the stack in `stacks.ts`.

### Prompts Directory Layout

```text
prompts/
├── architect/<stack>.md     System prompt for Phase 1 (no FS tools, design-only)
├── backend/<stack>.md       System prompt for Phase 2 (Convex/Supabase implementation)
├── frontend/<stack>.md      System prompt for Phase 3 (theme/components/screens)
├── template/<stack>.md      System prompt for follow-up single-agent turns
└── skills/{convex,expo,supabase}/<skill>/SKILL.md   On-demand skill docs
```

Each skill folder is auto-discovered; adding a new one makes it available to all agents via `lookupDocs`.

## Build Config

`build.js` uses esbuild: ESM format, bundles all deps, targets Node, outputs `dist/index.js`. The binary shebang and `chmod +x` are handled in the build script.

`tsconfig.json`: ES2022 target, strict mode, `NodeNext` module resolution.
