---
name: convex-node-actions
description: Convex actions (V8 default, or Node.js with `"use node"`) for `fetch`, third-party APIs, and npm packages with Node built-ins.
---

# Convex Actions & Node.js Runtime

Actions do non-deterministic work (`fetch`, third-party APIs, randomness). Two runtimes:

| Runtime                 | When to use                                                                          | How to opt in                                        |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **Convex default (V8)** | Default. `fetch` works. Most npm packages work. **No cold starts**. Same file as queries/mutations. | Just write `action({...})`.                          |
| **Node.js**             | Need a Node-only API (`fs`, `crypto`, `Buffer`, streams) or a package that imports them. | Put `"use node";` as the **first line** of the file. |

**Try the default runtime first.** If a deploy errors on a Node import like `fs` / `node:fs`, run `npx convex dev --once --debug-node-apis`.

## Default runtime — `fetch` works without `"use node"`

```ts
// convex/ai.ts — same file can have queries/mutations too
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

export const generate = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
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

```ts
'use node'; // MUST be the first line — before any imports

import { action } from './_generated/server';
import Stripe from 'stripe';

export const charge = action({
  args: { amount: v.number() },
  handler: async (_, { amount }) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    return await stripe.charges.create({ amount, currency: 'usd' });
  },
});
```

### Hard rules for `"use node"` files

- The directive must be the **very first line** — nothing before it.
- The file must contain **only actions** — no `query`, `mutation`, `internalQuery`, `internalMutation`.
- Files **without** `"use node"` must **not import** files **with** `"use node"`. The reverse is fine.
- Utility files using Node APIs but no Convex functions also need `"use node"`.
- Argument size limit is **5 MiB** in Node (vs 16 MiB in default).

### Node.js version

Defaults to **Node 20**. Configurable to 20 or 22 in `convex.json`. Self-hosted uses `.nvmrc`.

## General action rules

- **No `ctx.db`** — use `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`. Each call is its own transaction.
- **Env vars:** `process.env.MY_KEY`. Set via dashboard or `npx convex env set`.
- **Actions are not retried** on failure. Wrap or schedule a retry mutation.
- **Use `internal*` references** for queries/mutations called from actions.
- Long-running work is supported.

## Decision flow

1. DB-only and <1s? → **mutation/query**, not an action.
2. Need `fetch`, randomness, time, or third-party API? → **action**.
3. Need `fs`, `crypto`, `Buffer`, streams, or Node globals? → action with `"use node";`.
4. Otherwise → action without `"use node";` (faster, no cold start).
