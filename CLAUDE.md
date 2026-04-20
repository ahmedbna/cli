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
bna build --name my-app --stack expo-convex --prompt "describe app"
bna credits
bna config --show
```

No test suite or linter is configured in this repo.

## Architecture

### Entry & Command Routing

`src/index.ts` — Commander.js router. Commands: `login`, `logout`, `build`, `credits`, `config`.

### Build Pipeline (`src/commands/build.ts`)

1. Auth check + credits validation
2. Copy template from `templates/expo-convex/` to target directory
3. Start background `npm install` (InstallManager)
4. Create Session → launch REPL
5. First agent turn fires automatically with the user's prompt
6. After first turn: optional finalization (Convex init → TypeScript check → git init → expo run)

### Session & REPL (`src/session/`)

- `session.ts` — Holds conversation history, file operation journal (for `/undo`), env vars, turn count. Serializes to `.bna/session.json` for resumability across CLI restarts.
- `repl.ts` — Interactive readline loop; handles slash commands (`/help`, `/undo`, `/exit`, `/finalize`) and calls `agentTurn.ts` for each user message.
- `agentTurn.ts` — Orchestrates one AI generation round.

### Agent Core (`src/agent/`)

- `agent.ts` — Core loop: streams SSE from `/cli/chat` API, parses tool calls, executes tools, loops until `end_turn` (max 30 rounds). Tracks token usage and credits.
- `tools.ts` — 12 tool definitions (Zod schemas) + executors: `createFile`, `editFile`, `deleteFile`, `renameFile`, `viewFile`, `readMultipleFiles`, `listDirectory`, `searchFiles`, `runCommand`, `lookupDocs`, `addEnvironmentVariables`, `checkDependencies`.
- `contextManager.ts` — Manages conversation window; deduplicates recent `viewFile` calls to avoid redundant context.
- `skills.ts` — Auto-discovers and loads skills from `skills/*/SKILL.md` on demand via `lookupDocs` tool.
- `prompts.ts` + `prompts/` — Assembles the system prompt from modular sections (Convex guidelines, template guidelines, formatting, secrets, output instructions).

### Key Patterns

- **Streaming SSE**: Model output and tool results stream in real-time with live spinners via `liveSpinner.ts`.
- **Parallel install**: `installManager.ts` runs `npm install` in the background while the agent generates code; `runCommand` auto-waits if install is still running.
- **File journal**: Every file mutation is journaled in the session → `/undo` replays in reverse.
- **Skill system**: `skills/` contains 20+ self-contained `SKILL.md` files (e.g., `convex-file-storage`, `expo-animations`). The agent loads them dynamically via `lookupDocs` — only what's needed per session.
- **Session persistence**: `.bna/session.json` inside the generated project allows resuming a session after CLI restart.

### Utils (`src/utils/`)

| File | Purpose |
|---|---|
| `auth.ts` | OAuth token storage + refresh |
| `store.ts` | Conf-based persistent config (`~/.config/bna-cli/`) |
| `installManager.ts` | Background npm orchestration with streaming output |
| `tsCheck.ts` | TypeScript validation + autofix after generation |
| `gitInit.ts` | Git repo initialization post-build |
| `logger.ts` | Chalk-based pretty terminal output |
| `liveSpinner.ts` | Ora-based reusable spinners |

### Template

`templates/expo-convex/` — The starter project copied for every new app. Uses Expo Router (file-based routing) + Convex backend functions. Modifying this template affects all newly generated apps.

### Skills

`skills/<name>/SKILL.md` — Each skill is self-contained documentation the agent reads to guide code generation for that capability (e.g., Convex file storage, Expo animations, push notifications). Adding a new skill folder here makes it available to the agent automatically.

## Build Config

`build.js` uses esbuild: ESM format, bundles all deps, targets Node, outputs `dist/index.js`. The binary shebang and `chmod +x` are handled in the build script.

`tsconfig.json`: ES2022 target, strict mode, `NodeNext` module resolution.
