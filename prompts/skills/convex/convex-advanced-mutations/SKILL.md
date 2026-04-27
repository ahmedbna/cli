---
name: convex-advanced-mutations
description: Use when implementing batch inserts/updates, upsert patterns, cascade deletes, choosing between patch vs replace, or handling large transactions in Convex mutations. Trigger on "bulk create", "bulk update", "upsert", "delete related", "cascade delete", "patch vs replace", "transaction limit", or any mutation that writes multiple documents or needs to stay within transaction headroom.
---

# Convex Advanced Mutations

Mutations are **transactional**: all reads see a consistent snapshot, and all writes commit together or not at all. They must be deterministic — for third-party API calls, use actions.

## Batch insert / update

The whole mutation is one transaction. Convex queues every write and commits them together at the end, so a plain `for` loop is the recommended pattern:

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

**Loop vs `Promise.all`:** prefer the `for` loop. There's no real perf win from `Promise.all(items.map(...))` inside a mutation — there's still only one transaction commit, and parallel `await`s just shuffle JS-side bookkeeping. The loop gives deterministic ordering, cleaner stack traces, and a natural place to add per-item validation. Reach for `Promise.all` only when each item involves independent async work you genuinely want to overlap (e.g., several reads before a write).

## Upsert pattern

```ts
export const upsert = mutation({
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
    return ctx.db.insert('profiles', { userId, bio });
  },
});
```

## Patch vs Replace

```ts
// Patch: shallow merge. Sets new fields, overwrites existing ones,
// removes fields explicitly set to undefined.
await ctx.db.patch(id, { name: 'New Name' });
await ctx.db.patch(id, { tag: undefined }); // unsets `tag`

// Replace: swaps the whole document. Any field not provided is gone.
await ctx.db.replace(id, { name: 'New', email: 'new@example.com', bio: '' });
```

Default to `patch`. Use `replace` only when you need to guarantee every field is explicitly set (e.g., normalizing a record).

## Cascade delete

Stream related records with `for await` — they're fetched lazily, which is friendlier on memory than `.collect()` for large fan-outs:

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

Use `.collect()` instead when you need the array (e.g., to return it, or to count items first). For unbounded fan-outs that may exceed transaction limits, see below.

## Staying within transaction limits

Mutations have caps on bytes read/written and documents touched per transaction. For unbounded work, check headroom and reschedule:

```ts
const MiB = 1 << 20;

export const clearArchived = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tasks = ctx.db
      .query('tasks')
      .withIndex('by_status', (q) => q.eq('status', { archived: true }));

    for await (const task of tasks) {
      await ctx.db.delete(task._id);
      const m = await ctx.meta.getTransactionMetrics();
      if (
        m.bytesRead.used > 4 * MiB ||
        m.bytesWritten.used > 2 * MiB ||
        m.databaseQueries.remaining < 500
      ) {
        // Continue in a fresh transaction
        await ctx.scheduler.runAfter(0, internal.tasks.clearArchived);
        break;
      }
    }
  },
});
```

For paginated reads inside mutations, pass `maximumBytesRead` / `maximumRowsRead` in `PaginationOptions` to bound a single page. For schema-evolution-style migrations, prefer the official [migrations component](https://www.convex.dev/components/migrations) over hand-rolled loops.

## Returns

- Mutations may return any Convex value, or nothing.
- Returning `undefined` is translated to `null` on the client.
- From `@convex/react`, mutations from a single client are queued and executed in order.

## Rules

- Mutations are transactional — all writes succeed or all fail.
- Mutations must be deterministic — no `fetch`, no third-party APIs (use actions).
- NEVER use `.filter()` on queries — always use `.withIndex()`.
- ALWAYS include arg validators with `v.*`. Don't add return validators.
- For unbounded writes, check `ctx.meta.getTransactionMetrics()` and reschedule via `ctx.scheduler`.
