---
name: convex-scheduling
description: Scheduled functions (`runAfter`/`runAt`) and cron jobs (`convex/crons.ts`) for delayed and recurring tasks.
---

# Convex Scheduling

- **Scheduled functions** (`ctx.scheduler.runAfter` / `runAt`) — one-shot run from a mutation or action.
- **Cron jobs** (`convex/crons.ts`) — recurring schedules defined declaratively at deploy time.

## Runtime Scheduling

```ts
import { mutation, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

export const sendExpiringMessage = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    const id = await ctx.db.insert('messages', { body, author });
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

- `runAfter(delayMs, fnRef, args)` — delay in **milliseconds**.
- `runAt(timestampMs, fnRef, args)` — absolute Unix ms timestamp.
- Both return `Id<"_scheduled_functions">` for cancellation.

### Atomicity rules

- **From a mutation:** scheduling is part of the transaction. If the mutation rolls back, nothing is scheduled.
- **From an action:** scheduling is **not** transactional. An action can schedule then fail; the schedule still runs.

### `runAfter(0, ...)` pattern

Use from a mutation to trigger an action **only if the mutation commits**. Standard way to launch background work tied to a successful DB write.

### Queries can't schedule — only mutations and actions.

### Cancel

```ts
export const cancel = mutation({
  args: { scheduledId: v.id('_scheduled_functions') },
  handler: async (ctx, { scheduledId }) => ctx.scheduler.cancel(scheduledId),
});
```

If already running, it finishes — but anything **it** schedules is canceled (cascades to children).

### Inspecting scheduled runs

```ts
export const listScheduled = query({
  args: {},
  handler: (ctx) => ctx.db.system.query('_scheduled_functions').collect(),
});
```

Each row: `name`, `args`, `scheduledTime`, `completedTime`, `state` (`pending | inProgress | success | failed | canceled`). Retained **7 days** after completion.

## Cron Jobs — `convex/crons.ts`

File must be `convex/crons.ts` and `default export` the `cronJobs()` instance.

```ts
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Interval (supports seconds)
crons.interval('cleanup', { hours: 2 }, internal.cleanup.run, {});
crons.interval('sync', { minutes: 30 }, internal.sync.run, {});

// Named helpers — UTC times
crons.daily(
  'daily report',
  { hourUTC: 9, minuteUTC: 0 },
  internal.reports.daily,
  {},
);
crons.monthly(
  'payment reminder',
  { day: 1, hourUTC: 16, minuteUTC: 0 },
  internal.payments.sendPaymentEmail,
  { email: 'billing@example.com' },
);

// Standard 5-field cron (UTC)
crons.cron('nightly', '0 0 * * *', internal.reports.nightly, {});

export default crons;
```

| Helper                                                            | Use for                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `crons.interval(name, { seconds \| minutes \| hours }, fn, args)` | Simple recurring; supports seconds-level. First run on deploy.             |
| `crons.hourly` / `daily` / `weekly` / `monthly`                   | Common schedules with UTC fields.                                          |
| `crons.cron(name, "m h dom mon dow", fn, args)`                   | 5-field cron, UTC.                                                         |

### Cron rules

- First arg is a **unique identifier** — duplicates fail to deploy.
- Function ref is typically `internal.*`.
- Can be a mutation or action.
- **All times are UTC.**
- **At most one run executes at a time** — overlapping runs are skipped.

## Limits

- Up to **1000** functions scheduled per call, combined args **8 MB**.
- Results retained **7 days**.

## Error handling & retries

- **Scheduled mutations:** exactly-once. Convex retries transient errors.
- **Scheduled actions:** at-most-once. No automatic retries (side effects).
- For action retries, schedule a checking mutation that re-schedules if needed.

## Auth does **not** propagate

Auth context is not carried into scheduled runs. Pass `userId` explicitly and re-check in the handler.

## Quick decision guide

- "Run once X from now" → `ctx.scheduler.runAfter`
- "Run at exact timestamp" → `ctx.scheduler.runAt`
- "Run on a recurring schedule" → cron in `convex/crons.ts`
- "Trigger action conditionally on mutation success" → `runAfter(0, internal.x.action, ...)`
- "Cancel" → `ctx.scheduler.cancel(id)`
