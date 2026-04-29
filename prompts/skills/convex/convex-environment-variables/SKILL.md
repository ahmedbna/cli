---
name: convex-environment-variables
description: Read and manage Convex backend env vars (API keys, secrets) per-deployment via `process.env.NAME` and the `convex env` CLI.
---

# Convex Environment Variables

Per-deployment env vars (each dev/preview/prod has its own set). Read inside functions via `process.env.NAME`.

## Setting env vars

```bash
npx convex env list                          # list all
npx convex env get OPENAI_API_KEY            # read one
npx convex env set OPENAI_API_KEY 'sk-…'     # write one
npx convex env set --from-file .env.convex   # bulk import (KEY=value)
npx convex env remove OPENAI_API_KEY         # delete
```

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

`process.env.NAME` returns `string` if set, `undefined` otherwise. **Always null-check.**

Works in queries, mutations, actions (default and `"use node"`), HTTP actions, and crons.

## Per-deployment values

Set the same key with different values in dev vs prod:

```bash
npx convex env set STRIPE_SECRET_KEY 'sk_test_…'           # dev
npx convex env set --prod STRIPE_SECRET_KEY 'sk_live_…'    # prod
```

If a function reads `process.env.X`, set X in **every** deployment that runs it.

## System env vars (always set)

| Variable           | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| `CONVEX_CLOUD_URL` | `https://<deployment>.convex.cloud` — for Convex clients  |
| `CONVEX_SITE_URL`  | `https://<deployment>.convex.site` — for HTTP Actions     |

Use `CONVEX_SITE_URL` when registering webhook callbacks with third parties.

## Hard rules

### Don't condition function exports on env vars

```ts
// BROKEN — set of exported functions is fixed at deploy time
export const myFunc = process.env.DEBUG
  ? mutation(handler)
  : internalMutation(handler);
```

Branch **inside** the handler instead:

```ts
export const myFunc = mutation({
  handler: async (ctx) => {
    if (process.env.DEBUG) { /* dev-only path */ }
    /* normal path */
  },
});
```

### Don't use env vars in cron schedule definitions

Cron schedules are fixed at deploy.

### Don't bake env vars into module-level constants

```ts
// Risky — captures undefined at import time if the var isn't set
const KEY = process.env.OPENAI_API_KEY!;
```

Read inside the handler.

## Limits

| Thing                   | Limit                                         |
| ----------------------- | --------------------------------------------- |
| Env vars per deployment | 100                                           |
| Name length             | 40 chars                                      |
| Name format             | letter first, then letters/digits/underscores |
| Value size              | 8 KB                                          |

## Frontend env vars are different

Browser-bound vars (e.g. `EXPO_PUBLIC_CONVEX_URL`) live in your frontend's `.env.local`, **not** `npx convex env`. The Convex env var store is server-side only.

## Adding a new secret — checklist

1. `npx convex env set NEW_KEY 'value'` for dev.
2. `npx convex env set --prod NEW_KEY 'prod-value'` for prod.
3. Read inside the handler with a null-check.
4. For team dev deployments, add to **Project Settings → Default Environment Variables**.
