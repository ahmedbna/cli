---
name: convex-internal-functions
description: Use when calling Convex functions from within other functions — cross-context calls between queries, mutations, and actions, or hiding logic from the client. Trigger on "call query from action", "runQuery", "runMutation", "runAction", "api vs internal", "internalQuery", "internalMutation", "internalAction", "scheduler", or cross-function orchestration.
---

# Convex Cross-Function Calling & Internal Functions

## Public vs internal — the key distinction

By default, Convex functions are **public** and callable from any client. Anything sensitive (DB writes that bypass auth checks, paid-API calls, side-effecty work) should be **internal** — callable only from your own functions, scheduler, cron jobs, or HTTP actions. Reducing your public surface area is the main defense against malicious clients calling things they shouldn't.

| Helper                                                  | Use to define                                      |
| ------------------------------------------------------- | -------------------------------------------------- |
| `query` / `mutation` / `action`                         | Public — callable from clients via `api.module.fn` |
| `internalQuery` / `internalMutation` / `internalAction` | Internal — callable only via `internal.module.fn`  |

You can mix public and internal functions in the same file.

## Defining internal functions

```ts
// convex/plans.ts
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

export const markPlanAsProfessional = internalMutation({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    await ctx.db.patch(planId, { planType: 'professional' });
  },
});
```

Even though internal functions aren't client-reachable, **still validate args** and **still re-check invariants** — defense in depth. For internal queries/mutations, prefer passing **document IDs over whole documents** so the function reads the latest state.

## Calling from actions — queries, mutations, other actions

```ts
// convex/changes.ts
import { action } from './_generated/server';
import { internal, api } from './_generated/api';
import { v } from 'convex/values';

export const upgrade = action({
  args: { planId: v.id('plans') },
  handler: async (ctx, { planId }) => {
    // 1. Read via query
    const plan = await ctx.runQuery(api.plans.get, { planId });

    // 2. Side effect (third-party API)
    const response = await fetch('https://payments.example.com/charge');

    // 3. Write via internal mutation — client can't call this directly,
    //    so users can't grant themselves a free upgrade
    if (response.ok) {
      await ctx.runMutation(internal.plans.markPlanAsProfessional, { planId });
    }

    // 4. Chain to another action
    await ctx.runAction(internal.email.sendReceipt, { planId });
  },
});
```

## Calling from mutations — queries only, plus scheduling

Mutations can read via `runQuery` (same transaction) but **cannot** call other mutations or actions directly. To trigger a mutation or action from a mutation, **schedule it**:

```ts
export const processOrder = mutation({
  args: { orderId: v.id('orders') },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.runQuery(internal.orders.getInternal, { orderId });

    // Schedule an action to run after the mutation commits
    await ctx.scheduler.runAfter(0, internal.email.sendOrderConfirmation, {
      orderId,
    });
  },
});
```

## Reference objects

- `api.module.fn` — public function references (callable from clients and from any function)
- `internal.module.fn` — internal function references (callable only from server-side: actions, scheduler, crons, HTTP actions)

Both are auto-generated in `convex/_generated/api.ts`.

## Rules of thumb

- **Queries** can't call anything — they're pure reads.
- **Mutations** can `runQuery` (same transaction) and `scheduler.runAfter/runAt` mutations and actions.
- **Actions** can `runQuery`, `runMutation`, and `runAction`. Each call is its **own transaction** — no atomicity across them.
- **HTTP actions** behave like actions: they can `runQuery`, `runMutation`, `runAction`.
- **Default to `internal*`** for any function only meant to be called by other server-side code, scheduled, or run from cron / dashboard / CLI. Make a function public only when a client genuinely needs it.
- Internal functions can also be invoked from the **Convex Dashboard** and the **CLI** for debugging and admin tasks.
