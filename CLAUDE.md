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
6. After first turn: interactive prompt to run the finalization pipeline (5 steps: Convex init → TypeScript check + autofix → git init → Convex Auth → expo run:ios/android). `--no-run` skips only the final simulator launch (step 5); the rest of finalization still runs if the user confirms.

### Session & REPL (`src/session/`)

- `session.ts` — Holds conversation history, file operation journal (for `/undo`), env vars, turn count. Serializes to `.bna/session.json` for resumability across CLI restarts. `ContextManager` is initialized with `keepRecentRounds: 3`, `toolResultMaxChars: 400`, `createFileContentMaxChars: 200`, `viewDedupWindow: 4`.
- `repl.ts` — Interactive readline loop; handles slash commands and calls `agentTurn.ts` for each user message. Ctrl-C once interrupts the running agent turn; Ctrl-C twice within 2s exits. To resume a saved session, run `bna build` in (or with `--name` pointing to) the project directory — there is no separate `bna continue` CLI command, despite the hint printed at exit.
- `agentTurn.ts` — The main per-turn loop: streams SSE from `/cli/chat` (`CONVEX_SITE_URL`), parses tool calls, executes tools, loops until `end_turn` or `askUser`/`finish` (hard cap: `MAX_ROUNDS_PER_TURN = 30`, warning at `LONG_TURN_THRESHOLD = 20`). HTTP 401 triggers a token refresh and retry; HTTP 402 means insufficient credits. Retries 502/503/504 up to 3 times with exponential backoff.
- `planner.ts` — Defines `TurnOutcome` (`complete | clarify | interrupted | error`) and the `askUser` / `finish` tool definitions. A turn is a single round of model→tools→model; if the model calls `askUser`, the loop exits with `clarify` and the REPL collects the answer as a new user turn.

Full slash-command list (`/help` shows these at runtime):

| Command | Description |
| --- | --- |
| `/help` | Show command list |
| `/status` | Show session state and recent file changes |
| `/history` | Show last 20 file operations |
| `/undo` | Revert the most recent file operation |
| `/modify <desc>` | Ask the agent to modify the app |
| `/continue` | Ask the agent to pick up from where it left off |
| `/finalize` | Run the finalization pipeline (Convex init → tsc → git → Convex Auth → expo run) |
| `/clear` | Clear the screen |
| `/exit` | Save the session and quit |

### Agent Core (`src/agent/`)

- `agent.ts` — Headless agent loop (`runAgent`), used **only** by `tsCheck.ts` for TypeScript autofix during finalization. Not called during the interactive REPL. Tracks token usage and credits via custom SSE event types `bna_credits` / `bna_credits_final`.
- `tools.ts` — 12 tool definitions (Zod schemas) + executors: `createFile`, `editFile`, `deleteFile`, `renameFile`, `viewFile`, `readMultipleFiles`, `listDirectory`, `searchFiles`, `runCommand`, `lookupDocs`, `addEnvironmentVariables`, `checkDependencies`. (`askUser` / `finish` live in `session/planner.ts`.) `editFile` requires the `oldText` to appear exactly once in the file (under 1024 chars). `runCommand` default timeout is 180 s; npm-family commands are serialized behind the background install via `InstallManager`. `addEnvironmentVariables` only queues names — values are collected interactively during finalization.
- `contextManager.ts` — Manages conversation window; deduplicates recent `viewFile` calls to avoid redundant context.
- `skills.ts` — Auto-discovers and loads skills from `skills/<category>/<skill>/SKILL.md` on demand via `lookupDocs` tool.
- `prompts.ts` — Assembles the system prompt by reading markdown fragments from the top-level `prompts/` directory. Layout: `prompts/template/<stack>.md` (consolidated role + CLI mode + tools + workflow + output + secrets + example-data), `prompts/frontend/<fe>.md`, `prompts/backend/<be>.md`, `prompts/formatting.md`. The template md supports a `{{SKILLS_CATALOG}}` placeholder substituted at load time.

### Key Patterns

- **Streaming SSE**: Model output and tool results stream in real-time with live spinners via `liveSpinner.ts`.
- **Parallel install**: `installManager.ts` runs `npm install` in the background while the agent generates code; `runCommand` auto-waits if install is still running.
- **File journal**: Every file mutation is journaled in the session → `/undo` replays in reverse.
- **Skill system**: `prompts/skills/` is grouped by backend/frontend (`prompts/skills/convex/*`, `prompts/skills/expo/*`). Each leaf is a self-contained `SKILL.md` (e.g., `convex/convex-file-storage`, `expo/expo-animations`). The agent loads them dynamically via `lookupDocs` — only what's needed per session. To add a skill, drop a new folder under the appropriate category; it's auto-discovered.
- **Session persistence**: `.bna/session.json` inside the generated project allows resuming a session after CLI restart.
- **Clarification loop**: the `askUser` tool (see `session/planner.ts`) lets the model pause a turn for a user question instead of guessing. Do not add ad-hoc clarification prompts elsewhere — use this path.

### UI Layer (`src/ui/`)

The terminal UI is built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs). It activates when a TTY is detected; non-TTY / CI falls back to the legacy spinner path.

- `events.ts` — `uiBus` EventEmitter + `UiEvent` union type. Agent/tool code calls `emit(event)`; Ink components subscribe via `on(fn)`. `setUiActive(true)` gates all emissions — silent no-ops when UI is off.
- `App.tsx` — Root Ink component. Uses a **Static/Live split**: finalized items go into `<Static>` (rendered once, scrollback-safe); in-flight tool calls and streaming assistant text live in a re-rendering "live region" below. State is managed by a single `reducer(state, UiEvent)`.
- `toolAdapter.ts` — `createToolUi(kind, label)` returns a `ToolUi` interface whose methods (`progress`, `update`, `succeed`, `fail`) transparently dispatch to either the event bus (UI active) or the legacy Ora spinner (UI inactive). Tool executors in `tools.ts` call this instead of touching either renderer directly.
- `theme.ts` — Brand color palette (`accent: '#FAD40B'` BNA yellow) and the thinking spinner verb rotation (`Thinking`, `Cooking`, `Wiring`, …).
- `Header.tsx` — Prints the session header banner above the Ink app.
- `components/` — `Lines.tsx` (user/assistant/system lines), `ToolLine.tsx`, `Thinking.tsx` (round + token counter), `Input.tsx`, `SlashPalette.tsx`, `ClarifyPicker.tsx`.

**Key invariant**: tool code must never call `emit()` or `startSpinner()` directly — always go through `createToolUi` or `quickToolAction` so the dual-mode abstraction holds.

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

`prompts/skills/{convex,expo}/<skill>/SKILL.md` — Each skill is self-contained documentation the agent reads to guide code generation for that capability (e.g., `convex/convex-file-storage`, `expo/expo-animations`). Adding a new skill folder under the right category makes it available to the agent automatically via `lookupDocs`.

## Build Config

`build.js` uses esbuild: ESM format, bundles all deps, targets Node, outputs `dist/index.js`. The binary shebang and `chmod +x` are handled in the build script.

`tsconfig.json`: ES2022 target, strict mode, `NodeNext` module resolution.
