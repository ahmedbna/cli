---
name: convex-scheduling
description: Use when implementing cron jobs, scheduled functions, delayed execution, recurring tasks, self-destructing data, or background jobs in Convex. Trigger on "cron", "scheduled", "recurring", "runAfter", "runAt", "delayed", "timer", "background job", "expire", "TTL", "retry", or any time-based function execution.
---

# Convex Scheduling

Two related primitives:

- **Scheduled functions** (`ctx.scheduler.runAfter` / `runAt`) — schedule a one-shot run from inside a mutation or action. Stored in the database, durable across restarts, can be scheduled minutes to months out.
- **Cron jobs** (`convex/crons.ts`) — recurring schedules defined declaratively at deploy time.

## Runtime Scheduling

### Schedule after delay / at a time

```ts
import { mutation, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

export const sendExpiringMessage = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    const id = await ctx.db.insert('messages', { body, author });
    // Self-destruct in 5 seconds
    await ctx.scheduler.runAfter(5000, internal.messages.destruct, {
      messageId: id,
    });
  },
});

export const destruct = internalMutation({
  args: { messageId: v.id('messages') },
  handler: async (ctx, { messageId }) => ctx.db.delete(messageId),
});
```

- `runAfter(delayMs, fnRef, args)` — delay in **milliseconds** from now.
- `runAt(timestampMs, fnRef, args)` — absolute Unix timestamp in **milliseconds**.
- Both return an `Id<"_scheduled_functions">` you can store and later cancel.

### Atomicity rules — read carefully

- **From a mutation:** scheduling is part of the transaction. If the mutation commits, the schedule is guaranteed. If it throws, nothing is scheduled — even if the throw happens _after_ the `runAfter` call.
- **From an action:** scheduling is **not** transactional. An action can schedule a function and then fail; the scheduled run will still execute. Plan for this — don't assume "if my action errored, nothing was scheduled."

### `runAfter(0, ...)` — the immediate-side-effect pattern

Use `runAfter(0, internal.x.action, args)` from a mutation when you want to trigger an action only if the mutation commits. This is the standard way to launch background work (e.g., calling an external API) tied to a successful DB write. It's the equivalent of `setTimeout(fn, 0)` but transaction-aware.

### Mutations can schedule, actions can schedule — queries cannot

`ctx.scheduler` exists on mutation and action contexts. Queries are pure reads and have no scheduler.

### Cancel a scheduled run

```ts
export const cancel = mutation({
  args: { scheduledId: v.id('_scheduled_functions') },
  handler: async (ctx, { scheduledId }) => ctx.scheduler.cancel(scheduledId),
});
```

- If the run hasn't started, it won't run.
- If it's already running, it finishes — but anything **it** schedules is canceled (cancellation cascades to children).

### Inspecting scheduled runs

Scheduled functions live in the `_scheduled_functions` system table. Read with `ctx.db.system.get` / `ctx.db.system.query`:

```ts
export const listScheduled = query({
  args: {},
  handler: (ctx) => ctx.db.system.query('_scheduled_functions').collect(),
});
```

Each row has `name`, `args`, `scheduledTime`, `completedTime`, and `state`:
`"pending" | "inProgress" | "success" | "failed" | "canceled"`. Results are retained for **7 days** after completion.

## Cron Jobs — `convex/crons.ts`

Recurring schedules. The file must be `convex/crons.ts` and `default export` the `cronJobs()` instance.

```ts
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Interval — finer than traditional cron (supports seconds)
crons.interval('cleanup', { hours: 2 }, internal.cleanup.run, {});
crons.interval('sync', { minutes: 30 }, internal.sync.run, {});

// Named helpers — UTC times, explicit fields
crons.daily(
  'daily report',
  { hourUTC: 9, minuteUTC: 0 },
  internal.reports.daily,
  {},
);
crons.monthly(
  'payment reminder',
  { day: 1, hourUTC: 16, minuteUTC: 0 }, // 1st of month at 16:00 UTC
  internal.payments.sendPaymentEmail,
  { email: 'billing@example.com' }, // arg passed to the function
);

// Standard 5-field cron syntax (UTC). Use crontab.guru to verify.
crons.cron('nightly', '0 0 * * *', internal.reports.nightly, {});

export default crons;
```

Supported schedule helpers:

| Helper                                                            | Use for                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `crons.interval(name, { seconds \| minutes \| hours }, fn, args)` | Simple recurring; supports **seconds-level** granularity. First run fires when the cron is first deployed. |
| `crons.hourly` / `daily` / `weekly` / `monthly`                   | Common schedules with named UTC fields — clearer than raw cron strings.                                    |
| `crons.cron(name, "m h dom mon dow", fn, args)`                   | Traditional 5-field cron, **always UTC**.                                                                  |

### Cron rules & gotchas

- The first arg is a **unique identifier** — duplicate names fail to deploy.
- Function ref is typically `internal.*` (you don't want clients invoking your cleanup job).
- Scheduled work can be a **mutation or action**.
- **All cron times are UTC.** Don't hand-write local-time crons; convert first.
- **At most one run of a given cron executes at a time.** If the previous run is still going when the next is due, the next is **skipped** (logged on the dashboard). Keep cron handlers fast or use a fan-out pattern: cron schedules an action that immediately schedules child mutations/actions.

## Limits

- A single function can schedule up to **1000** functions per call, with combined argument size up to **8 MB**.
- Scheduled-function results are kept for **7 days** in `_scheduled_functions`.

## Error handling & retries

- **Scheduled mutations are exactly-once.** Convex retries internal/transient errors automatically; only developer errors fail the run.
- **Scheduled actions are at-most-once.** Side effects mean Convex won't retry. If you need retry semantics, do it yourself: schedule a mutation that checks whether the work is done and re-schedules the action if not.
- Cron-triggered functions follow the same rules (cron is just a trigger for scheduled mutations/actions).

## Auth does **not** propagate

The auth context of whoever scheduled a function is **not** carried into the scheduled run. If the scheduled function needs a user identity, pass `userId` (or whatever you need) as an explicit argument and re-check authorization inside the handler.

## Quick decision guide

- "Run this once, X seconds/minutes/hours from now" → `ctx.scheduler.runAfter`
- "Run this at this exact timestamp" → `ctx.scheduler.runAt`
- "Run this every X / on a schedule forever" → cron in `convex/crons.ts`
- "Trigger an action conditionally on a mutation succeeding" → `runAfter(0, internal.x.action, ...)` from the mutation
- "Cancel a not-yet-run schedule" → `ctx.scheduler.cancel(id)`
