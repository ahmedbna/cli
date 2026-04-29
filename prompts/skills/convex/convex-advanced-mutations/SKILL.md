---
name: convex-advanced-mutations
description: Patterns for non-trivial Convex mutations — batch inserts/updates, upsert, patch vs replace, cascade delete, scheduling, and staying inside per-mutation transaction limits.
---

# Convex Advanced Mutations

Mutations are **transactional** and **deterministic** — no `fetch`, no `Math.random()` from outside Convex's runtime. For external API calls, use an `action`.

## Batch insert / update

A mutation is a single transaction — a plain `for` loop is the right shape. Prefer it over `Promise.all` for deterministic ordering and readable stack traces.

```ts
export const createMany = mutation({
  args: { items: v.array(v.object({ text: v.string() })) },
  handler: async (ctx, { items }) => {
    const ids = [];
    for (const item of items) {
      ids.push(await ctx.db.insert('tasks', item));
    }
    return ids;
  },
});
```

## Upsert

No built-in upsert. Look up by index, then `patch` or `insert`:

```ts
export const upsertProfile = mutation({
  args: { userId: v.id('users'), bio: v.string() },
  handler: async (ctx, { userId, bio }) => {
    const existing = await ctx.db
      .query('profiles')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { bio });
      return existing._id;
    }
    return await ctx.db.insert('profiles', { userId, bio });
  },
});
```

## Patch vs replace

```ts
// patch: shallow merge. Setting a field to undefined removes it.
await ctx.db.patch(id, { name: 'New Name' });
await ctx.db.patch(id, { tag: undefined }); // unsets `tag`

// replace: swaps the entire document. Missing fields are gone.
await ctx.db.replace(id, { name: 'New', email: 'new@x.com', bio: '' });
```

Default to `patch`. Use `replace` only when fully overwriting is the point.

## Cascade delete

Use `for await` to stream — friendlier on memory than `.collect()` for big fan-outs:

```ts
export const deleteUser = mutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const todos = ctx.db
      .query('todos')
      .withIndex('by_user', (q) => q.eq('userId', userId));

    for await (const t of todos) {
      await ctx.db.delete(t._id);
    }
    await ctx.db.delete(userId);
  },
});
```

## Staying within transaction limits

Caps per mutation: **~16,384 documents**, **~8 MiB**, **~1 second**. For unbounded work, check headroom mid-loop and reschedule:

```ts
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';

const MiB = 1 << 20;

export const clearArchived = internalMutation({
  args: {},
  handler: async (ctx) => {
    const archived = ctx.db
      .query('tasks')
      .withIndex('by_status', (q) => q.eq('status', 'archived'));

    for await (const task of archived) {
      await ctx.db.delete(task._id);

      const m = await ctx.meta.getTransactionMetrics();
      if (
        m.bytesRead.used > 4 * MiB ||
        m.bytesWritten.used > 2 * MiB ||
        m.databaseQueries.remaining < 500
      ) {
        await ctx.scheduler.runAfter(0, internal.tasks.clearArchived);
        return;
      }
    }
  },
});
```

For schema-evolution work (backfills), use the [`migrations` component](https://www.convex.dev/components/migrations).

## Scheduling follow-up work

`ctx.scheduler` writes are part of the current transaction — if the mutation rolls back, nothing is scheduled.

```ts
await ctx.scheduler.runAfter(0, internal.tasks.next);
await ctx.scheduler.runAfter(60_000, internal.email.sendNudge, { userId });
await ctx.scheduler.runAt(Date.parse('2030-01-01'), internal.cron.yearly);
```

## Calling actions from a mutation

Mutations can't `fetch`. Schedule an action instead:

```ts
const orderId = await ctx.db.insert("orders", { ... });
await ctx.scheduler.runAfter(0, internal.payments.charge, { orderId });
return orderId;
```

## Validation

```ts
export const updateTask = mutation({
  args: {
    id: v.id('tasks'),
    text: v.optional(v.string()),
    done: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, ...patch }) => {
    await ctx.db.patch(id, patch);
  },
});
```

- Always declare `args` with `v.*` validators.
- Don't add return validators; let TypeScript infer.
- Use `v.optional(...)` for patch-style args.

## Rules

- Any thrown error rolls back every write.
- Deterministic only — no `fetch`. Use `action` + schedule.
- Reads use `.withIndex()`, never `.filter()` on large tables.
- Default to `patch`; `replace` only for full overwrites.
- For unbounded writes, watch `getTransactionMetrics()` + reschedule.
- Use `for await` to stream large sets; `.collect()` only when you need the array.
- Mutations are queued per client.

## Quick decision table

| Need                           | Use                                                            |
| ------------------------------ | -------------------------------------------------------------- |
| Insert one row                 | `ctx.db.insert("table", doc)`                                  |
| Update some fields             | `ctx.db.patch(id, partial)`                                    |
| Overwrite the whole doc        | `ctx.db.replace(id, fullDoc)`                                  |
| Delete one row                 | `ctx.db.delete(id)`                                            |
| Insert/update many rows        | `for` loop with `await` per item                               |
| Upsert                         | index lookup + `unique()` → `patch` or `insert`                |
| Delete related rows            | `for await` over indexed query, then `delete`                  |
| Work that may exceed limits    | check `getTransactionMetrics()` + `scheduler.runAfter(0, ...)` |
| Call external API after write  | `scheduler.runAfter(0, internal.x.action, args)`               |
| Schema-wide backfill           | `migrations` component                                         |
| Big aggregate / counter update | Aggregate or Sharded Counter component                         |
