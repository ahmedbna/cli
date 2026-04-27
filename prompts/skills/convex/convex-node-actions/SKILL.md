---
name: convex-node-actions
description: Use when implementing Convex actions, choosing between Convex's default runtime and Node.js, calling third-party APIs (OpenAI, Stripe, etc.), or using npm packages that need Node built-ins. Trigger on "external API", "use node", "fetch API", "OpenAI", "Stripe", "third-party API", "npm package", "process.env", "Node.js runtime", or any action calling services outside Convex.
---

# Convex Actions & Node.js Runtime

Actions are the only Convex function type allowed to do non-deterministic work — `fetch`, third-party APIs, randomness, time-dependent logic. They run in **one of two runtimes**:

| Runtime                 | When to use                                                                                                                     | How to opt in                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Convex default (V8)** | Default. `fetch` works. Most npm packages work. **No cold starts**, faster, and can live in the same file as queries/mutations. | Just write a normal `action({...})`.                 |
| **Node.js**             | Need a Node-only API (`fs`, `crypto`, `Buffer`, streams) or an npm package that imports them.                                   | Put `"use node";` as the **first line** of the file. |

**Try the default runtime first.** Only reach for `"use node"` when you hit an unsupported package or Node API. If a deploy errors on a Node import like `fs` / `node:fs`, run `npx convex dev --once --debug-node-apis` to find which import dragged it in.

## Default runtime — `fetch` works without `"use node"`

```ts
// convex/ai.ts — same file can have queries/mutations too
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

export const generate = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    // No ctx.db in actions — use runQuery/runMutation
    const history = await ctx.runQuery(internal.messages.list, {});

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [...history, { role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.choices[0].message.content;

    await ctx.runMutation(internal.messages.save, { text });
    return text;
  },
});
```

## Node.js runtime — `"use node";` directive

Use this **only** when you need a Node-only library or API.

```ts
'use node'; // MUST be the first line — before any imports

import { action } from './_generated/server';
import Stripe from 'stripe'; // npm package that needs Node built-ins

export const charge = action({
  args: { amount: v.number() },
  handler: async (_, { amount }) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    return await stripe.charges.create({ amount, currency: 'usd' });
  },
});
```

### Hard rules for `"use node"` files

- The directive must be the **very first line** — nothing before it, not even a comment that triggers an import.
- The file must contain **only actions** — no `query`, `mutation`, `internalQuery`, or `internalMutation`. Those will fail to bundle.
- Files **without** `"use node"` must **not import** files **with** `"use node"`. The reverse is fine.
- Utility files (e.g. `convex/pdf-utils.ts`) that use Node APIs but export no Convex functions also need `"use node"`.
- Argument size limit is **5 MiB** in Node (vs 16 MiB in the default runtime).

### Node.js version

Defaults to **Node 20**. Configurable to 20 or 22 in `convex.json`. After bumping, old code may run on the previous version for a few minutes during rollout. (Self-hosted Convex ignores `convex.json` and uses `.nvmrc` instead.)

## General action rules

- **No `ctx.db`** — use `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`. Each call is its own transaction.
- **Env vars:** `process.env.MY_KEY`. Set via dashboard or `npx convex env set MY_KEY value`.
- **Actions are not automatically retried** on failure. If you need retries, wrap the call yourself or schedule a retry mutation.
- **Use `internal*` references** for the queries/mutations you call from inside an action — they shouldn't be reachable from clients.
- Long-running work is supported; actions have a much longer execution budget than queries/mutations (which are sub-second).

## Decision flow

1. Does the work read/write the DB only and finish in <1s? → **mutation/query**, not an action.
2. Does it need `fetch`, randomness, time, or a third-party API? → **action**.
3. Does the npm package or API need `fs`, `crypto`, `Buffer`, streams, or Node-specific globals? → action with `"use node";`.
4. Otherwise → action without `"use node";` (faster, no cold start, can share a file with queries/mutations).
