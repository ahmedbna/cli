---
name: convex-advanced-mutations
description: Patterns for non-trivial Convex mutations — batch inserts and updates, upsert, patch vs replace, cascade delete, scheduling work that won't fit in one transaction, and staying inside Convex's per-mutation read/write caps. Use this skill whenever writing or editing a Convex `mutation` or `internalMutation` that touches more than one document, or whenever the user mentions "bulk create", "bulk update", "batch insert", "upsert", "delete related rows", "cascade delete", "patch vs replace", "transaction limit", "too many documents", "too many bytes read", "schedule a follow-up mutation", `ctx.scheduler`, `getTransactionMetrics`, or migrations. Also trigger when fixing a mutation that hits Convex's transaction limits, when deciding between `patch` and `replace`, or when reviewing whether a loop should use `for await` vs `.collect()` vs `Promise.all`.
---

# Convex Advanced Mutations

Mutations are **transactional**: every read sees a consistent snapshot, and every write commits together or not at all. They must be **deterministic** — no `fetch`, no third-party APIs, no `Math.random()` from outside Convex's runtime. If you need any of that, do the work in an `action` and call the mutation from there.

## Batch insert / update

A mutation is a single transaction. Convex queues writes and commits them together at the end, so a plain `for` loop is the right shape:

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

**Loop vs `Promise.all`:** prefer the `for` loop. There's no commit-time win from `Promise.all(items.map(...))` — it's still one transaction — and parallel `await`s only shuffle JS-side bookkeeping. The loop gives deterministic ordering, readable stack traces, and a natural place to validate per item. Reach for `Promise.all` only when each item does independent async work worth overlapping (e.g., several reads before each write).

## Upsert

There is no built-in upsert. Look up by index, then `patch` or `insert`:

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

If the lookup field needs to be unique, add a unique index and rely on `.unique()` throwing when more than one row exists — that's your collision check.

## Patch vs replace

```ts
// patch: shallow merge. Sets new fields, overwrites existing ones,
// and *removes* fields explicitly set to undefined.
await ctx.db.patch(id, { name: 'New Name' });
await ctx.db.patch(id, { tag: undefined }); // unsets `tag`

// replace: swaps the entire document. Any field you don't include is gone.
await ctx.db.replace(id, { name: 'New', email: 'new@x.com', bio: '' });
```

Default to `patch`. Use `replace` only when you need to guarantee every field is explicitly set (e.g., normalizing a record from external input, or after a schema change).

## Cascade delete

Stream related rows with `for await` — they're fetched lazily, which is friendlier on memory than `.collect()` for big fan-outs:

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

Use `.collect()` only when you actually need the array (to return it, count it, or process the whole set as data). For deletes whose size you can't bound, see the next section.

## Staying within transaction limits

A single mutation can read at most **~16,384 documents** and **~8 MiB**, write a comparable bounded amount, and run for **~1 second**. For work that may exceed those caps, check headroom mid-loop and reschedule the rest:

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
        // Continue in a fresh transaction.
        await ctx.scheduler.runAfter(0, internal.tasks.clearArchived);
        return;
      }
    }
  },
});
```

Notes:

- Use `internalMutation` for the rescheduled function so it isn't part of your public API.
- Keep the safety thresholds well below the hard caps — you still need room for the rest of the loop iteration plus the scheduler write.
- For **paginated reads inside a mutation**, pass `maximumBytesRead` / `maximumRowsRead` in `PaginationOptions` to bound a single page.
- For schema-evolution work (backfilling a new field, splitting a table), use the official [`migrations` component](https://www.convex.dev/components/migrations) instead of hand-rolling this pattern.

## Scheduling follow-up work

`ctx.scheduler` writes a row that runs another function later. The schedule itself is part of the current transaction — if the mutation rolls back, the scheduled job never gets created.

```ts
await ctx.scheduler.runAfter(0, internal.tasks.next); // ASAP, new tx
await ctx.scheduler.runAfter(60_000, internal.email.sendNudge, { userId });
await ctx.scheduler.runAt(Date.parse('2030-01-01'), internal.cron.yearly);
```

Use this for: continuing past transaction limits, deferring expensive side effects to an action, debouncing, and any "do X, then later do Y" flow.

## Calling actions from a mutation

Mutations can't `fetch`. To kick off third-party work after a write commits, schedule an action:

```ts
const orderId = await ctx.db.insert("orders", { ... });
await ctx.scheduler.runAfter(0, internal.payments.charge, { orderId });
return orderId;
```

The action runs in a separate, non-transactional context and can hit external APIs.

## Returns and client behavior

- Mutations may return any Convex value, or nothing.
- A returned `undefined` is translated to `null` on the client.
- Mutations from a single React client are **queued and executed in order**, so optimistic UI updates and dependent calls behave predictably.

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

- Always declare `args` with `v.*` validators — they protect against malformed client calls and give you typed handler args for free.
- Don't add return validators on mutations; let TypeScript infer the return type.
- Use `v.optional(...)` for patch-style args so callers can update one field at a time.

## Rules

- All-or-nothing: any thrown error rolls back every write in the mutation.
- Deterministic only — no `fetch`, no external APIs. Use an `action` and schedule it.
- Reads use `.withIndex()`, never `.filter()` on a non-trivial table.
- Default to `patch`; reach for `replace` only when fully overwriting is the point.
- For unbounded writes, watch `ctx.meta.getTransactionMetrics()` and reschedule via `ctx.scheduler`.
- Use `for await` to stream large result sets; use `.collect()` only when you need the array.
- Mutations are queued per client — don't fight the queue with your own locking.

## Quick decision table

| Need                           | Use                                                            |
| ------------------------------ | -------------------------------------------------------------- |
| Insert one row                 | `ctx.db.insert("table", doc)`                                  |
| Update some fields             | `ctx.db.patch(id, partial)`                                    |
| Overwrite the whole doc        | `ctx.db.replace(id, fullDoc)`                                  |
| Delete one row                 | `ctx.db.delete(id)`                                            |
| Insert/update many rows        | `for` loop with `await` per item                               |
| Upsert                         | index lookup + `unique()` → `patch` or `insert`                |
| Delete related rows            | `for await` over an indexed query, then `delete`               |
| Work that may exceed limits    | check `getTransactionMetrics()` + `scheduler.runAfter(0, ...)` |
| Call external API after write  | `scheduler.runAfter(0, internal.x.action, args)`               |
| Schema-wide backfill           | `migrations` component                                         |
| Big aggregate / counter update | Aggregate or Sharded Counter component                         |
