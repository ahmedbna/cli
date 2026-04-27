# BNA CLI

An AI-powered CLI that generates production-ready full-stack mobile apps from a single natural language prompt. Describe your app; BNA scaffolds the project, writes all the code, wires the backend, and launches it in a simulator — all from your terminal.

---

## How It Works

1. Run `bna` (or `bna init`) and describe your app in plain English.
2. BNA copies a starter template (Expo + your chosen backend) into a new directory.
3. `npm install` starts in the background while the three-phase AI pipeline immediately begins.
4. **Phase 1 — Architect**: plans the app architecture (screens, data model, API contracts, theme) and produces a structured Blueprint. No code is written yet.
5. **Phase 2 — Backend Builder**: implements the backend (Convex schema + functions, or Supabase migrations + API) using the Blueprint as its spec. Skipped for Expo-only stacks.
6. **Phase 3 — Frontend Builder**: implements the theme, UI components, tab layout, and every screen using the finalized API contracts from Phase 2.
7. When the pipeline finishes, the CLI offers to run a finalization pipeline: initializes the backend, type-checks, commits a git snapshot, configures auth, and launches the app in a simulator.
8. The session and Blueprint are saved to `.bna/` so you can keep iterating in later runs — follow-up turns use a single-agent loop with the Blueprint injected as context.

---

## Prerequisites

- **Node 20+**
- **Xcode** (iOS) or **Android Studio** (Android)
- Stack-specific:
  - **Expo + Convex**: a [Convex](https://convex.dev) account (free tier works)
  - **Expo + Supabase**: [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker Desktop

---

## Installation

```bash
npm install -g bna
```

Or run locally after cloning:

```bash
npm run build
node dist/index.js
```

---

## Authentication

```bash
bna login     # opens browser OAuth; stores token in ~/.config/bna-cli/
bna logout    # clears saved credentials
bna credits   # check remaining credit balance
```

---

## Building an App

### Interactive (recommended)

```bash
bna
```

BNA prompts you to choose a frontend, backend, project name, and app description.

### With flags

```bash
bna init \
  --name my-app \
  --frontend expo \
  --backend convex \
  --prompt "A habit tracker with streaks, reminders, and a leaderboard"
```

`bna` and `bna init` are identical — use whichever reads more naturally in your workflow.

| Flag                  | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `-n, --name <name>`   | Project directory name                                              |
| `-p, --prompt <text>` | Natural language app description                                    |
| `-f, --frontend <fe>` | `expo`                                                              |
| `-b, --backend <be>`  | `convex`, `supabase`, or omit for no backend                        |
| `--skills <list>`     | Comma-separated Agent Skills (e.g. `pptx,xlsx,docx,pdf`)           |
| `--no-install`        | Skip background `npm install`                                       |
| `--no-run`            | Skip launching the simulator after finalization (other steps still run) |

### Resuming a session

Run `bna` inside (or `bna init --name <dir>` pointing to) an existing project directory. BNA detects `.bna/session.json` or `.bna/blueprint.json` and continues the conversation where you left off.

---

## Supported Stacks

| Stack           | Template                   | Backend                                      |
| --------------- | -------------------------- | -------------------------------------------- |
| `expo-convex`   | `templates/expo-convex/`   | Convex — DB + realtime + auth + file storage |
| `expo-supabase` | `templates/expo-supabase/` | Supabase — Postgres + Auth + Realtime + RLS  |
| `expo`          | `templates/expo/`          | None — local data via AsyncStorage / MMKV    |

All three templates share the same Expo Router layout, component structure, and theming system.

---

## Finalization Pipeline

After the first agent turn, BNA offers to run finalization. It can also be triggered anytime with `/finalize` in the REPL.

| Step                | What runs                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1. Backend init     | `npx convex dev --once` (Convex) · `npm run db:reset && npm run db:types` (Supabase)                                   |
| 2. TypeScript check | `tsc --noEmit` — if errors are found, a headless agent loop auto-fixes them                                            |
| 3. Git snapshot     | `git init && git add . && git commit`                                                                                  |
| 4. Auth + env vars  | `npx @convex-dev/auth` (Convex) · Supabase key prompts · any queued `addEnvironmentVariables` collected interactively  |
| 5. Launch           | `npx expo run:ios` or `npx expo run:android` (skipped with `--no-run`)                                                 |

---

## REPL Slash Commands

Once an app is running, the interactive REPL accepts these commands:

| Command                 | Description                                |
| ----------------------- | ------------------------------------------ |
| `/help`                 | Show all commands                          |
| `/modify <description>` | Ask the agent to modify the app            |
| `/continue`             | Ask the agent to pick up where it left off |
| `/finalize`             | Manually trigger the finalization pipeline |
| `/undo`                 | Revert the most recent file write          |
| `/status`               | Session state and recent file changes      |
| `/history`              | Last 20 file operations                    |
| `/clear`                | Clear the terminal                         |
| `/exit`                 | Save session and quit                      |

**Interrupt behavior**: Ctrl-C once cancels the running agent turn. Ctrl-C twice within 2 seconds exits and saves the session.

---

## Agent Skills

Skills are on-demand documentation files the agent reads before writing code for advanced features. They live in `prompts/skills/<category>/<skill>/SKILL.md` and are auto-discovered.

### Available skills

**Convex**

| Skill                       | When it's loaded                        |
| --------------------------- | --------------------------------------- |
| `convex-advanced-queries`   | Complex filtered queries, ordering      |
| `convex-advanced-mutations` | Transactions, conditional writes        |
| `convex-scheduling`         | Cron jobs and delayed actions           |
| `convex-file-storage`       | Upload / serve files via Convex storage |
| `convex-full-text-search`   | Built-in search indexes                 |
| `convex-pagination`         | Cursor-based pagination                 |
| `convex-http-actions`       | Custom HTTP endpoints                   |
| `convex-node-actions`       | Server-side Node.js actions             |
| `convex-function-calling`   | Calling external APIs from actions      |
| `convex-presence`           | Real-time presence and cursors          |
| `convex-types`              | TypeScript type patterns                |

**Expo**

| Skill                   | When it's loaded                       |
| ----------------------- | -------------------------------------- |
| `expo-animations`       | `react-native-reanimated` patterns     |
| `expo-image-media`      | Camera, image picker, media library    |
| `expo-haptics-gestures` | Haptic feedback, gesture handling      |
| `expo-routing`          | Advanced Expo Router patterns          |
| `expo-dev-build`        | Dev client and native module workflows |
| `expo-eas-build`        | EAS Build, OTA updates                 |

To add a skill: create `prompts/skills/<category>/<skill-name>/SKILL.md`. It is auto-discovered and listed in the agent's catalog on the next run.

---

## Agent Tools

The agent has 12 tools available during code generation:

| Tool                      | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `createFile`              | Write a complete new file                         |
| `editFile`                | Replace a unique string in an existing file       |
| `viewFile`                | Read a file                                       |
| `readMultipleFiles`       | Batch file reads                                  |
| `listDirectory`           | List directory contents                           |
| `searchFiles`             | Grep for a pattern across files                   |
| `deleteFile`              | Delete a file                                     |
| `renameFile`              | Rename or move a file                             |
| `runCommand`              | Shell commands (restricted to `npx expo install`) |
| `lookupDocs`              | Load a skill doc on demand                        |
| `addEnvironmentVariables` | Queue env-var names for the finalization phase    |
| `checkDependencies`       | Check background install state                    |

`askUser` and `finish` (defined in `session/planner.ts`) let the agent pause for a clarifying question or signal completion with a summary.

---

## Architecture

```text
src/
├── index.ts                 # Commander.js CLI entry; routes bna / bna init / login / credits / config
├── commands/
│   ├── build.ts             # Context detection, template copy, parallel install, finalization
│   ├── stacks.ts            # SUPPORTED_STACKS registry, combineStack helper
│   ├── login.ts / logout.ts
│   ├── credits.ts
│   └── config.ts
├── session/
│   ├── session.ts           # Conversation history, file journal, Blueprint storage, .bna/ serialization
│   ├── repl.ts              # Interactive readline loop; routes initial build → orchestrator, follow-ups → agentTurn
│   ├── orchestrator.ts      # Wires Phase 1→2→3; persists blueprint between phases
│   ├── agentTurn.ts         # Single-agent loop for follow-up turns; injects Blueprint as context
│   └── planner.ts           # TurnOutcome type, askUser / finish tool definitions
├── agent/
│   ├── agent.ts             # Headless loop (used only by tsCheck autofix)
│   ├── tools.ts             # 12 Zod-typed tool definitions + executors
│   ├── blueprint.ts         # Blueprint interface + formatters (formatTablesForAgent, etc.)
│   ├── architectPrompt.ts   # Loads prompts/architect|backend|frontend/<stack>.md at runtime
│   ├── prompts.ts           # Loads prompts/template/<stack>.md for follow-up turns
│   ├── skills.ts            # Auto-discovers prompts/skills/**/ and generates catalog
│   └── contextManager.ts    # Conversation window trimming, viewFile deduplication
├── agents/
│   ├── architectAgent.ts    # Phase 1: no FS tools, max 8 rounds, calls proposeBlueprint
│   ├── backendAgent.ts      # Phase 2: writes convex/* or supabase/*, max 25 rounds, calls finishBackend
│   └── frontendAgent.ts     # Phase 3: full tool set, max 30 rounds, calls finish
├── ui/
│   ├── App.tsx              # Root Ink component — Static (finalized) / Live (in-flight) split
│   ├── events.ts            # uiBus EventEmitter + UiEvent union type; setUiActive gate
│   ├── toolAdapter.ts       # createToolUi — Ink or Ora, transparent to tool executors
│   ├── theme.ts             # BNA brand palette + thinking spinner verbs
│   ├── Header.tsx
│   └── components/          # Lines, ToolLine, Thinking, Input, SlashPalette, ClarifyPicker
└── utils/
    ├── apiClient.ts         # Shared HTTP client: fetchStream, fetchStreamWithRetry (502/503/504 backoff), extractErrorMessage
    ├── auth.ts              # OAuth token storage + silent refresh
    ├── store.ts             # Conf-based config at ~/.config/bna-cli/
    ├── credits.ts           # Balance check, pre-turn gating
    ├── installManager.ts    # Background npm orchestration; serializes runCommand calls
    ├── tsCheck.ts           # tsc --noEmit + headless autofix agent loop
    ├── gitInit.ts           # Post-build git init + initial commit
    ├── logger.ts            # Chalk pretty-print helpers
    ├── liveSpinner.ts       # Ora reusable spinners (legacy path)
    └── shell.ts             # ANSI stripping for tool output

prompts/
├── architect/
│   ├── expo-convex.md       # Phase 1 system prompt — Expo + Convex
│   ├── expo-supabase.md     # Phase 1 system prompt — Expo + Supabase
│   └── expo.md              # Phase 1 system prompt — Expo only
├── backend/
│   ├── expo-convex.md       # Phase 2 system prompt — Convex implementation
│   └── expo-supabase.md     # Phase 2 system prompt — Supabase implementation
├── frontend/
│   ├── expo-convex.md       # Phase 3 system prompt — Expo + Convex frontend
│   ├── expo-supabase.md     # Phase 3 system prompt — Expo + Supabase frontend
│   └── expo.md              # Phase 3 system prompt — Expo only frontend
├── template/
│   ├── expo-convex.md       # Follow-up single-agent system prompt — Expo + Convex
│   ├── expo-supabase.md     # Follow-up single-agent system prompt — Expo + Supabase
│   └── expo.md              # Follow-up single-agent system prompt — Expo only
└── skills/
    ├── convex/              # 11 skill docs
    ├── expo/                # 6 skill docs
    └── supabase/

templates/
├── expo-convex/             # Expo Router + Convex + @convex-dev/auth starter
├── expo-supabase/           # Expo Router + Supabase + TanStack Query starter
└── expo/                    # Expo Router only starter
```

### Key design decisions

**Three-phase pipeline** — The initial build splits across three isolated agents. The Architect produces a structured Blueprint (~2–5KB JSON) that flows to the Backend Builder, which produces the actual implemented API contracts, which flow to the Frontend Builder. No conversation history crosses phase boundaries. Total token cost: ~130–285K vs ~700K–1M for a single-agent approach.

**Blueprint as inter-agent contract** — `src/agent/blueprint.ts` defines the `Blueprint` interface: screens, data model, API contracts, theme direction, env vars, and architect notes. The Backend Builder amends API contracts to match what it actually implemented; the orchestrator re-persists the amended blueprint before Phase 3 runs.

**Follow-up turns stay single-agent** — After the initial build, `/modify`, free-form chat, and `/continue` use a single-agent loop (`agentTurn.ts`) with the Blueprint injected as context. The multi-agent split adds overhead without benefit for small incremental changes.

**Shared HTTP client** — All four agents (`architectAgent`, `backendAgent`, `frontendAgent`, `agentTurn`) share `src/utils/apiClient.ts` for all `/cli/chat` requests. It handles retries with exponential backoff on 502/503/504, and strips raw HTML from proxy error pages into readable messages.

**Parallel install** — `npm install` starts the moment the template is copied, before any code is written. `runCommand` calls for `npx expo install` auto-serialize behind it via `InstallManager` — the agent never has to wait or check.

**Phase-isolated system prompts** — Each phase has its own prompt per stack (`prompts/architect/`, `prompts/backend/`, `prompts/frontend/`). Follow-up turns use `prompts/template/<stack>.md`. No prompt assembly from fragments.

**Dual-mode UI** — The Ink/React terminal UI activates on TTY; non-TTY/CI falls back to Ora spinners. All tool code goes through `createToolUi` in `toolAdapter.ts` — never writes to stdout directly. This is a hard invariant.

**File journal + `/undo`** — Every `createFile`, `editFile`, `deleteFile`, `renameFile` is appended to the session's operation journal. `/undo` replays in reverse.

**Clarification without blocking** — When the Architect needs user input it calls `askUser({ question, options? })`. The turn exits with outcome `clarify`; the REPL collects the answer and feeds it back. Backend and Frontend agents cannot ask — design is settled before they run.

**Session persistence** — `.bna/session.json` and `.bna/blueprint.json` inside the generated project hold the full conversation history, file journal, env-var queue, and architectural plan. Running `bna` in that directory resumes automatically, skipping the orchestrator and going straight to follow-up mode.

---

## Extending BNA

### Add a skill

Create `prompts/skills/<category>/<skill-name>/SKILL.md`. It is auto-discovered on the next run and listed in the agent's catalog. The agent calls `lookupDocs({ skills: ["skill-name"] })` to load it when relevant.

### Add a stack

1. Create `templates/<stack>/` with a working Expo starter project.
2. Create `prompts/architect/<stack>.md`, `prompts/backend/<stack>.md`, `prompts/frontend/<stack>.md`, and `prompts/template/<stack>.md` following the shape of the existing stack prompts.
3. Add the stack id to `SUPPORTED_STACKS` in `src/commands/stacks.ts`.
4. Add any backend-specific finalization branch (init command, env-var prompts) in `src/commands/build.ts`.

---

## Development

```bash
npm run build   # esbuild → dist/index.js (ESM, all deps bundled, Node target)
npm run dev     # build + run immediately
```

No test suite or linter is configured. TypeScript: ES2022 target, strict mode, NodeNext module resolution.

---

## License

MIT
