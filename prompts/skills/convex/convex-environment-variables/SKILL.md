---
name: convex-environment-variables
description: Use when reading API keys, secrets, configuration, or any environment variable in Convex backend functions, or when setting/managing environment variables across dev and prod deployments. Trigger on "process.env", "API key", "secret", "env var", "environment variable", "OPENAI_API_KEY", "STRIPE_SECRET", "convex env", "deployment config", or any external service credential.
---

# Convex Environment Variables

Convex env vars are **per-deployment** (each dev, preview, and prod deployment has its own set) and are read inside functions via `process.env.NAME`.

## Setting env vars

### CLI (recommended for scripted setup)

```bash
npx convex env list                      # list all
npx convex env get OPENAI_API_KEY        # read one
npx convex env set OPENAI_API_KEY 'sk-…' # write one
npx convex env set --from-file .env.convex   # bulk import
npx convex env remove OPENAI_API_KEY     # delete
```

The `--from-file` flag reads a standard `KEY=value` file — the easiest way to bootstrap a fresh deployment.

## Reading env vars in functions

```ts
import { action } from './_generated/server';
import { v } from 'convex/values';

export const callGiphy = action({
  args: { query: v.string() },
  handler: async (_, { query }) => {
    const key = process.env.GIPHY_KEY;
    if (!key) throw new Error('GIPHY_KEY not set');
    const url = `https://api.giphy.com/v1/gifs/translate?api_key=${key}&s=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    return res.json();
  },
});
```

`process.env.NAME` returns a `string` if set, `undefined` otherwise. **Always null-check** — TypeScript can't enforce it, and a missing env var is a common cause of silent prod breakage.

`process.env` works in queries, mutations, actions (default and `"use node"` runtime), HTTP actions, and crons.

## Per-deployment values — same key, different value

Because env vars live per-deployment, you typically want the **same name with different values** in dev vs prod:

| Deployment | `STRIPE_SECRET_KEY` |
| ---------- | ------------------- |
| dev        | `sk_test_…`         |
| preview    | `sk_test_…`         |
| prod       | `sk_live_…`         |

Set each one individually (`npx convex env set …` runs against the currently selected deployment — switch with `--prod` or `npx convex deploy`). If a function reads `process.env.X`, **set X in every deployment that runs that function** — otherwise it'll be `undefined` in whichever deployment you forgot.

## System env vars (always set, no config needed)

| Variable           | Value                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| `CONVEX_CLOUD_URL` | e.g. `https://<your deployment name>.convex.cloud` — for Convex clients         |
| `CONVEX_SITE_URL`  | e.g. `https://<your deployment name>.convex.site` — for HTTP Actions / webhooks |

Use `CONVEX_SITE_URL` when registering webhook callbacks with third parties (Stripe, Clerk, etc.) so the URL automatically tracks the deployment.

## Hard rules — these break in subtle ways

### Don't condition function exports on env vars

```ts
// BROKEN — set of exported functions is fixed at deploy time
export const myFunc = process.env.DEBUG
  ? mutation(handler)
  : internalMutation(handler);
```

The set of callable Convex functions is locked in at deploy. Changing `DEBUG` afterward won't change which export wins — it'll throw at runtime.

Branch **inside** the handler instead:

```ts
export const myFunc = mutation({
  handler: async (ctx) => {
    if (process.env.DEBUG) {
      /* dev-only path */
    }
    /* normal path */
  },
});
```

### Don't use env vars in cron schedule definitions

Cron schedules are also fixed at deploy. Reading `process.env` to _decide_ a cron interval won't be re-evaluated when the env var changes.

### Don't bake env vars into module-level constants

```ts
// Risky — captures undefined at import time if the var isn't set yet
const KEY = process.env.OPENAI_API_KEY!;
```

Read inside the handler so a missing-var bug surfaces with a clear error per call, not a cryptic startup failure.

## Limits

| Thing                   | Limit                                         |
| ----------------------- | --------------------------------------------- |
| Env vars per deployment | 100                                           |
| Name length             | 40 chars                                      |
| Name format             | letter first, then letters/digits/underscores |
| Value size              | 8 KB                                          |

## Frontend env vars are different

Variables that need to reach the **browser** (e.g. `VITE_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_URL`) live in your frontend build tool's env files (`.env.local`, etc.), **not** in `npx convex env`. The Convex env var store is server-side only.

## Quick checklist when adding a new secret

1. `npx convex env set NEW_KEY 'value'` for dev.
2. `npx convex env set --prod NEW_KEY 'prod-value'` for prod.
3. Read it inside the handler: `const v = process.env.NEW_KEY; if (!v) throw new Error("NEW_KEY missing")`.
4. If new teammates will create their own dev deployments, add it to **Project Settings → Default Environment Variables** so their fresh deployments get a sensible default.
