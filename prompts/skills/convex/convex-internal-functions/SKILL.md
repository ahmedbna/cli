---
name: convex-internal-functions
description: Cross-function calls (`runQuery`, `runMutation`, `runAction`) and `internalQuery`/`internalMutation`/`internalAction` for hiding logic from clients.
---

# Convex Cross-Function Calling & Internal Functions

## Public vs internal

By default, Convex functions are **public** and callable from any client. Anything sensitive should be **internal** — callable only from your own functions, scheduler, cron jobs, or HTTP actions.

| Helper                                                  | Use to define                                      |
| ------------------------------------------------------- | -------------------------------------------------- |
| `query` / `mutation` / `action`                         | Public — callable from clients via `api.module.fn` |
| `internalQuery` / `internalMutation` / `internalAction` | Internal — callable only via `internal.module.fn`  |

You can mix public and internal in the same file.

## Defining internal functions

```ts
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

export const markPlanAsProfessional = internalMutation({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    await ctx.db.patch(planId, { planType: 'professional' });
  },
});
```

Even though internal, **still validate args** and **re-check invariants**. Prefer passing **document IDs over whole documents** so the function reads the latest state.

## Calling from actions — queries, mutations, other actions

```ts
import { action } from './_generated/server';
import { internal, api } from './_generated/api';
import { v } from 'convex/values';

export const upgrade = action({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    const plan = await ctx.runQuery(api.plans.get, { planId });

    const response = await fetch('https://payments.example.com/charge');

    if (response.ok) {
      await ctx.runMutation(internal.plans.markPlanAsProfessional, { planId });
    }

    await ctx.runAction(internal.email.sendReceipt, { planId });
  },
});
```

## Calling from mutations — queries only, plus scheduling

Mutations can `runQuery` (same transaction) but **cannot** call other mutations or actions directly. Schedule them instead:

```ts
export const processOrder = mutation({
  args: { orderId: v.id('orders') },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.runQuery(internal.orders.getInternal, { orderId });

    await ctx.scheduler.runAfter(0, internal.email.sendOrderConfirmation, {
      orderId,
    });
  },
});
```

## Reference objects

- `api.module.fn` — public function references (clients + any function)
- `internal.module.fn` — internal references (server-side only: actions, scheduler, crons, HTTP actions)

Both are auto-generated in `convex/_generated/api.ts`.

## Rules of thumb

- **Queries** can't call anything — they're pure reads.
- **Mutations** can `runQuery` (same transaction) and `scheduler.runAfter/runAt` mutations and actions.
- **Actions** can `runQuery`, `runMutation`, and `runAction`. Each call is its **own transaction**.
- **HTTP actions** behave like actions.
- **Default to `internal*`** for any function only meant to be called server-side. Make public only when a client genuinely needs it.
- Internal functions can also be invoked from the **Convex Dashboard** and **CLI** for debugging.
