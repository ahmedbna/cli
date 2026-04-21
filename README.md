# BNA CLI

CLI AI agent that builds full-stack mobile apps (Expo + Convex) directly from your terminal.

## Installation

```bash
npm install -g bna
```

Or run directly:

```bash
npx bna
```

## Development

```bash
npm install
npm run build        # bundles via esbuild → dist/index.js
npm run dev          # build + run immediately
node dist/index.js   # run the built CLI
```

## Quick Start

### 1. Authenticate

```bash
bna login
```

Opens your browser to sign in with your BNA account. Your session persists across CLI runs.

### 2. Build an app

```bash
bna build
```

The CLI will interactively ask for your stack and a description of your app. Or pass everything inline:

```bash
bna build --name my-fitness-app --frontend expo --backend convex --prompt "A fitness tracker with workout logging, progress charts, and a dark theme"
```

Opt in to additional Agent Skills (e.g. spreadsheet or presentation generation):

```bash
bna build --skills pptx,xlsx
```

Skip the auto-install or simulator launch steps:

```bash
bna build --no-install --no-run
```

### What happens under the hood

1. **Template copied** — `templates/expo-convex/` is copied to your project directory
2. **Dependencies installed** — `npm install` runs in the background while the agent generates code
3. **AI agent runs** — Customizes theme, components, schema, functions, and screens based on your prompt (up to 30 rounds)
4. **Finalization** — Convex init → TypeScript check + autofix → git init → Convex Auth setup → expo run:ios/android
5. **Session saved** — `.bna/session.json` persists the conversation so you can resume after a CLI restart

## Commands

| Command | Description |
| --- | --- |
| `bna login` | Authenticate with BNA |
| `bna logout` | Clear saved authentication |
| `bna build` | Build a mobile app (alias: `bna b`) |
| `bna credits` | Check your credit balance |
| `bna config --show` | View current configuration |

### Build flags

| Flag | Description |
| --- | --- |
| `--name <name>` | Project name / directory |
| `--frontend <fe>` | Frontend stack (e.g. `expo`) |
| `--backend <be>` | Backend stack (e.g. `convex`) |
| `--prompt <text>` | App description |
| `--skills <list>` | Comma-separated opt-in skill names |
| `--no-install` | Skip background `npm install` |
| `--no-run` | Skip the final simulator launch |

## REPL Slash Commands

Once the agent finishes its first turn you drop into an interactive REPL. Type `/help` to see all commands:

| Command | Description |
| --- | --- |
| `/modify <desc>` | Ask the agent to modify the app |
| `/continue` | Ask the agent to pick up from where it left off |
| `/finalize` | Re-run the finalization pipeline |
| `/undo` | Revert the most recent file operation |
| `/status` | Show session state and recent file changes |
| `/history` | Show last 20 file operations |
| `/clear` | Clear the screen |
| `/exit` | Save the session and quit |

Press **Esc** to interrupt a running agent turn. **Ctrl-C** twice within 2 s exits.

To resume a saved session, run `bna build` inside (or with `--name` pointing to) the existing project directory.

## Agent Tools

The AI agent has access to these tools:

| Tool | Description |
| --- | --- |
| `createFile` | Write a complete new file |
| `editFile` | Replace a specific string in a file |
| `viewFile` | Read file contents (with optional line range) |
| `readMultipleFiles` | Read several files at once |
| `listDirectory` | List directory contents (supports recursive) |
| `searchFiles` | Search for patterns across the codebase |
| `runCommand` | Execute shell commands |
| `deleteFile` | Delete a file or empty directory |
| `renameFile` | Move/rename a file |
| `lookupDocs` | Load a skill document for specialized guidance |
| `addEnvironmentVariables` | Queue env var names for collection at finalization |
| `checkDependencies` | Verify installed packages |

## Skills

The agent can load self-contained skill documents on demand to guide specialized code generation. Skills live in `skills/{convex,expo}/<skill>/SKILL.md`. Adding a new folder under the right category makes it available automatically.

## Architecture

```
bna/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── commands/
│   │   ├── build.ts          # Template copy → install → agent → finalize
│   │   ├── login.ts          # Browser-based OAuth flow
│   │   ├── logout.ts         # Clear auth
│   │   ├── credits.ts        # Credit balance check
│   │   ├── config.ts         # CLI configuration
│   │   └── stacks.ts         # Stack selection helpers
│   ├── agent/
│   │   ├── agent.ts          # Core agentic loop (streaming SSE, 30-round cap)
│   │   ├── tools.ts          # 12 tool definitions + executors
│   │   ├── prompts.ts        # System prompt assembly from prompts/ fragments
│   │   ├── contextManager.ts # Conversation window + viewFile deduplication
│   │   └── skills.ts         # Auto-discovery of skills/ directory
│   ├── session/
│   │   ├── session.ts        # Conversation history, file journal, .bna/session.json
│   │   ├── repl.ts           # Interactive readline loop + slash commands
│   │   ├── agentTurn.ts      # Orchestrates one AI generation round
│   │   └── planner.ts        # TurnOutcome + askUser clarification tool
│   ├── ui/
│   │   ├── events.ts         # uiBus event bus (UiEvent union type)
│   │   ├── App.tsx           # Ink root component (Static/Live split)
│   │   ├── toolAdapter.ts    # createToolUi — dual-mode tool renderer
│   │   ├── Header.tsx
│   │   └── components/       # Lines, ToolLine, Thinking, Input, SlashPalette, ClarifyPicker
│   └── utils/
│       ├── auth.ts           # OAuth token storage + refresh
│       ├── store.ts          # Persistent config (~/.config/bna-cli/)
│       ├── installManager.ts # Background npm orchestration
│       ├── tsCheck.ts        # TypeScript validation + autofix
│       ├── gitInit.ts        # Git repo initialization
│       └── logger.ts         # Chalk-based terminal output
├── templates/
│   └── expo-convex/          # Full-stack template (Expo Router + Convex + @convex-dev/auth)
├── skills/
│   ├── convex/               # Convex-specific skill docs
│   └── expo/                 # Expo-specific skill docs
├── prompts/                  # Modular system prompt fragments
├── build.js                  # esbuild bundler (ESM, targets Node → dist/index.js)
└── package.json
```

## License

MIT
