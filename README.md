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

### 2. Generate an app

```bash
bna generate
```

The CLI will interactively ask for:

- **Project name** (auto-detected from directory if empty)
- **Stack** — Expo only, or Expo + Convex (full-stack)
- **Prompt** — describe your app in natural language

Or pass everything inline:

```bash
bna generate --name my-fitness-app --stack expo-convex --prompt "A fitness tracker with workout logging, progress charts, and a dark theme"
```

### 3. Run your app

```bash
cd my-fitness-app
npx convex dev          # Start backend (keep running)
npx expo run:ios        # iOS simulator
npx expo run:android    # Android emulator
```

## Commands

| Command                           | Description                            |
| --------------------------------- | -------------------------------------- |
| `bna login`                       | Authenticate with BNA                  |
| `bna logout`                      | Clear saved authentication             |
| `bna generate`                    | Generate a mobile app (alias: `bna g`) |
| `bna credits`                     | Check your credit balance              |
| `bna config --show`               | View current configuration             |
| `bna config --api-key sk-ant-...` | Use your own Anthropic API key         |

## Using Your Own API Key

If you prefer to use your own Anthropic API key instead of BNA credits:

```bash
bna config --api-key sk-ant-your-key-here
```

Or set the environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
bna generate
```

## How It Works

The CLI runs a local AI agent powered by Claude that:

1. **Plans** the app architecture (theme → components → schema → screens)
2. **Writes files** directly to your file system
3. **Runs commands** (npm install, convex deploy) via real shell
4. **Iterates** on errors automatically (up to 30 rounds)

The agent uses the same system prompts and architecture patterns as the [BNA web app](https://ai.ahmedbna.com), ensuring production-quality output with proper Expo dev builds, Convex backend, file-based routing, and reusable UI components.

## Architecture

```
bna/
├── src/
│   ├── index.ts              # CLI entry point (Commander.js)
│   ├── commands/
│   │   ├── login.ts           # Browser-based OAuth flow
│   │   ├── generate.ts        # Main generation flow
│   │   ├── credits.ts         # Credit balance check
│   │   ├── logout.ts          # Clear auth
│   │   └── config.ts          # CLI configuration
│   ├── agent/
│   │   ├── agent.ts           # Core agentic loop (Anthropic API)
│   │   ├── prompts.ts         # System prompts (from bna-agent)
│   │   └── tools.ts           # Tool definitions + executors
│   └── utils/
│       ├── store.ts           # Persistent config (Conf)
│       ├── logger.ts          # Pretty CLI output
│       └── credits.ts         # Credit management
├── build.js                   # esbuild bundler
└── package.json
```

## License

MIT
