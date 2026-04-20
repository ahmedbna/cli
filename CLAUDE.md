# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

BNA CLI is an AI-powered CLI tool that generates full-stack mobile apps (Expo + Convex) from natural language prompts. It uses Claude (via Anthropic SDK) as an agentic code generation engine that reads/writes files and runs shell commands in an interactive REPL loop.

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
bna build --name my-app --frontend expo --backend convex --prompt "describe app"
bna build --skills pptx,xlsx  # opt-in Agent Skills
bna build --no-install --no-run   # skip post-gen steps
bna credits
bna config --show
```

No test suite or linter is configured in this repo. If no subcommand is given, `bna` falls through to `configCommand()` (see `src/index.ts`), not `build`.

## Architecture

### Entry & Command Routing

`src/index.ts` — Commander.js router. Commands: `login`, `logout`, `build` (alias `b`), `credits`, `config`, plus `stacks.ts` helpers for stack selection. Build flags are `--frontend`, `--backend`, `--skills`, `--no-install`, `--no-run`.

### Build Pipeline (`src/commands/build.ts`)

Context-aware entry logic:
- `--name` given, or empty directory → scaffold new project + run REPL
- Existing directory with `.bna/session.json` → resume saved session
- Existing BNA-like project (has `package.json` + `app/`) but no session → prompt: fresh session or new subdirectory
- Other non-empty directory → prompt for project name

After context resolution:
1. Auth check + credits validation
2. Copy template from `templates/expo-convex/` to target directory
3. Start background `npm install` (InstallManager) unless `--no-install`
4. Create Session → launch REPL
5. First agent turn fires automatically with the user's prompt
6. After first turn: prompt to run finalization (Convex init → TypeScript check → git init → Convex Auth → expo run) — skipped with `--no-run`

### Session & REPL (`src/session/`)

- `session.ts` — Holds conversation history, file operation journal (for `/undo`), env vars, turn count. Serializes to `.bna/session.json` for resumability across CLI restarts.
- `repl.ts` — Interactive readline loop; handles slash commands (`/help`, `/undo`, `/exit`, `/finalize`) and calls `agentTurn.ts` for each user message.
- `agentTurn.ts` — Orchestrates one AI generation round.
- `planner.ts` — Defines `TurnOutcome` (`complete | clarify | interrupted | error`) and the `askUser` tool. A turn is a single round of model→tools→model; if the model calls `askUser`, the loop exits with `clarify` and the REPL collects the answer as a new user turn.

### Agent Core (`src/agent/`)

- `agent.ts` — Core loop: streams SSE from `/cli/chat` API, parses tool calls, executes tools, loops until `end_turn` (max 30 rounds). Tracks token usage and credits.
- `tools.ts` — 12 tool definitions (Zod schemas) + executors: `createFile`, `editFile`, `deleteFile`, `renameFile`, `viewFile`, `readMultipleFiles`, `listDirectory`, `searchFiles`, `runCommand`, `lookupDocs`, `addEnvironmentVariables`, `checkDependencies`. (`askUser` lives in `session/planner.ts`.)
- `contextManager.ts` — Manages conversation window; deduplicates recent `viewFile` calls to avoid redundant context.
- `skills.ts` — Auto-discovers and loads skills from `skills/<category>/<skill>/SKILL.md` on demand via `lookupDocs` tool.
- `prompts.ts` — Assembles the system prompt by reading markdown fragments from the top-level `prompts/` directory. Layout: `prompts/system/role/<stack>.md`, `prompts/system/cli/<stack>.md`, `prompts/system/output/<stack>.md`, `prompts/frontend/<fe>.md`, `prompts/backend/<be>.md`, `prompts/system/secrets/<be|none>.md`, `prompts/system/example-data/<be|none>.md`, `prompts/system/formatting.md`. The cli md file supports a `{{SKILLS_CATALOG}}` placeholder substituted at load time.

### Key Patterns

- **Streaming SSE**: Model output and tool results stream in real-time with live spinners via `liveSpinner.ts`.
- **Parallel install**: `installManager.ts` runs `npm install` in the background while the agent generates code; `runCommand` auto-waits if install is still running.
- **File journal**: Every file mutation is journaled in the session → `/undo` replays in reverse.
- **Skill system**: `skills/` is grouped by backend/frontend (`skills/convex/*`, `skills/expo/*`). Each leaf is a self-contained `SKILL.md` (e.g., `convex/convex-file-storage`, `expo/expo-animations`). The agent loads them dynamically via `lookupDocs` — only what's needed per session. To add a skill, drop a new folder under the appropriate category; it's auto-discovered.
- **Session persistence**: `.bna/session.json` inside the generated project allows resuming a session after CLI restart.
- **Clarification loop**: the `askUser` tool (see `session/planner.ts`) lets the model pause a turn for a user question instead of guessing. Do not add ad-hoc clarification prompts elsewhere — use this path.

### Utils (`src/utils/`)

| File                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `auth.ts`           | OAuth token storage + refresh                                    |
| `store.ts`          | Conf-based persistent config (`~/.config/bna-cli/`)              |
| `credits.ts`        | Credit balance helpers used by `bna credits` and pre-turn gating |
| `installManager.ts` | Background npm orchestration with streaming output               |
| `tsCheck.ts`        | TypeScript validation + autofix after generation                 |
| `gitInit.ts`        | Git repo initialization post-build                               |
| `logger.ts`         | Chalk-based pretty terminal output                               |
| `liveSpinner.ts`    | Ora-based reusable spinners                                      |
| `shell.ts`          | Terminal output cleaning / ANSI stripping                        |
| `stripIndent.ts`    | Template-literal indent helper for prompt strings                |

### Templates

`templates/expo-convex/` — The only currently active template. Uses Expo Router (file-based routing) with Convex backend and `@convex-dev/auth` pre-wired. Modifying it affects every newly generated app. Supabase/Swift stacks are stubbed in `stacks.ts` but commented out; add a `templates/<frontend>-<backend>/` directory and update `SUPPORTED_STACKS` to activate one.

### Skills

`skills/{convex,expo}/<skill>/SKILL.md` — Each skill is self-contained documentation the agent reads to guide code generation for that capability (e.g., `convex/convex-file-storage`, `expo/expo-animations`). Adding a new skill folder under the right category makes it available to the agent automatically via `lookupDocs`.

## Build Config

`build.js` uses esbuild: ESM format, bundles all deps, targets Node, outputs `dist/index.js`. The binary shebang and `chmod +x` are handled in the build script.

`tsconfig.json`: ES2022 target, strict mode, `NodeNext` module resolution.
