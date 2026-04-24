---
name: convex-scheduling
description: Use when implementing cron jobs, scheduled functions, delayed execution, or recurring tasks in Convex. Trigger on "cron", "scheduled", "recurring", "run after", "run at", "delayed", "timer", "background job", or any time-based function execution.
---

# Convex Scheduling

## Cron Jobs — convex/crons.ts

Define recurring tasks in `convex/crons.ts`.

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Run every 2 hours
crons.interval("cleanup", { hours: 2 }, internal.cleanup.run, {});

// Standard cron syntax: minute hour day-of-month month day-of-week
crons.cron("daily report", "0 0 * * *", internal.reports.daily, {});

// Every 30 minutes
crons.interval("sync", { minutes: 30 }, internal.sync.run, {});

export default crons;
```

### Cron rules

- Cron handlers must be `internal` mutations or actions
- The file must be `convex/crons.ts` and export default the cronJobs instance
- Cron expressions use UTC timezone
- Use `interval` for simple recurring schedules, `cron` for specific times

## Runtime Scheduling

Schedule functions to run after a delay or at a specific time from within mutations/actions.

### Schedule after delay

```ts
export const scheduleReminder = mutation({
  args: { userId: v.id("users"), msg: v.string(), delayMs: v.number() },
  handler: async (ctx, { userId, msg, delayMs }) => {
    await ctx.scheduler.runAfter(delayMs, internal.reminders.send, { userId, msg });
  },
});
```

### Schedule at specific time

```ts
export const scheduleAt = mutation({
  args: { userId: v.id("users"), msg: v.string(), timestamp: v.number() },
  handler: async (ctx, { userId, msg, timestamp }) => {
    await ctx.scheduler.runAt(timestamp, internal.reminders.send, { userId, msg });
  },
});
```

### Cancel a scheduled function

```ts
export const cancel = mutation({
  args: { scheduledId: v.id("_scheduled_functions") },
  handler: async (ctx, { scheduledId }) => {
    await ctx.scheduler.cancel(scheduledId);
  },
});
```

### Runtime scheduling rules

- `ctx.scheduler` is available in mutations and actions
- `runAfter(delayMs, fnRef, args)` — delay in milliseconds
- `runAt(timestamp, fnRef, args)` — Unix timestamp in milliseconds
- Returns a `Id<"_scheduled_functions">` that can be stored and used to cancel
- Scheduled function references should be `internal` for security
