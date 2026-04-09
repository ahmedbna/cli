# BNA CLI

CLI AI agent that builds full-stack apps directly from your terminal.

## Development

```bash
npm install
node build.js
node dist/index.js --help
```

## Installation

```bash
npm install -g bna
```

Or run directly:

```bash
npx bna
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

The CLI will interactively ask for:

- **Stack** — Expo only, or Expo + Convex (full-stack)
- **Prompt** — describe your app in natural language

Or pass everything inline:

```bash
bna build --name my-fitness-app --stack expo-convex --prompt "A fitness tracker with workout logging, progress charts, and a dark theme"
```

### What happens under the hood

1. **Template copied** — The correct template (expo or expo-convex) is copied to your project directory
2. **Dependencies installed** — `npm install` runs automatically
3. **Convex auth initialized** — `npx @convex-dev/auth` runs for expo-convex projects
4. **AI agent runs** — Customizes theme, components, schema, functions, and screens based on your prompt
5. **File streaming** — Every file the agent writes is streamed to your terminal with syntax-highlighted line numbers
6. **Auto-start** — Convex dev server starts in background, then Expo dev build launches (iOS on macOS, Android otherwise)

## Commands

| Command             | Description                         |
| ------------------- | ----------------------------------- |
| `bna login`         | Authenticate with BNA               |
| `bna logout`        | Clear saved authentication          |
| `bna build`         | Build a mobile app (alias: `bna b`) |
| `bna credits`       | Check your credit balance           |
| `bna config --show` | View current configuration          |

## How It Works

The CLI runs a local AI agent powered by Claude that:

1. **Copies** the project template matching your chosen stack
2. **Installs** dependencies automatically
3. **Customizes** the app — theme, components, schema, backend, screens
4. **Streams** every file write to your terminal so you see exactly what's happening
5. **Starts** Convex backend + Expo dev build automatically
6. **Iterates** on errors automatically (up to 30 rounds)

The agent uses the same system prompts and architecture patterns as the [BNA web app](https://ai.ahmedbna.com), ensuring production-quality output with proper Expo dev builds, Convex backend, file-based routing, and reusable UI components.

## Agent Tools

The AI agent has access to these tools:

| Tool                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `createFile`        | Write a complete file (streamed to terminal)         |
| `editFile`          | Replace a specific string in a file                  |
| `viewFile`          | Read file contents (with optional line range)        |
| `readMultipleFiles` | Read several files at once                           |
| `listDirectory`     | List directory contents (supports recursive)         |
| `runCommand`        | Execute shell commands (for installing new packages) |
| `deleteFile`        | Delete a file or empty directory                     |
| `renameFile`        | Move/rename a file                                   |
| `searchFiles`       | Search for patterns across the codebase              |

## Architecture

```
bna/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── commands/
│   │   ├── login.ts           # Browser-based OAuth flow
│   │   ├── build.ts           # Template copy → install → agent → auto-start
│   │   ├── credits.ts         # Credit balance check
│   │   ├── logout.ts          # Clear auth
│   │   └── config.ts          # CLI configuration
│   ├── agent/
│   │   ├── agent.ts           # Core agentic loop (streaming SSE)
│   │   ├── prompts.ts         # System prompts
│   │   ├── prompts/           # Modular prompt sections
│   │   └── tools.ts           # Tool definitions + executors + terminal streaming
│   └── utils/
│       ├── store.ts           # Persistent config (Conf)
│       ├── logger.ts          # Pretty CLI output
│       ├── credits.ts         # Credit management
│       ├── shell.ts           # Terminal output cleaning
│       └── stripIndent.ts     # Template literal helper
├── templates/
│   └── expo-convex/           # Full-stack template (copied per project)
├── build.js                   # esbuild bundler
└── package.json
```

## License

MIT
