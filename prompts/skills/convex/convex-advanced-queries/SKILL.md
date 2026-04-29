---
name: convex-advanced-queries
description: Patterns for non-trivial Convex queries — compound indexes, range filters, ordering/limits, joins, aggregations, pagination, and conditional skip queries.
---

# Convex Advanced Queries

Convex queries are reactive, cached, and **deterministic** — no `fetch`, no `Math.random()`. For external work, use an `action`.

## Core rule: indexes, not `.filter()`

`.filter()` does not use indexes. On non-trivial tables, define an index in `convex/schema.ts` and use `.withIndex()`.

```ts
// schema.ts
defineTable({
  channel: v.id('channels'),
  user: v.id('users'),
  body: v.string(),
})
  .index('by_channel', ['channel'])
  .index('by_channel_user', ['channel', 'user']);
```

`_creationTime` is appended to **every** index automatically — don't add it explicitly.

## Index range expressions

Inside `withIndex`, step through fields **in index order**:
1. Zero or more `.eq()` on leading fields.
2. Optionally one range op (`.gt`/`.gte`/`.lt`/`.lte`) on the next field.
3. Nothing after a range op.

```ts
const recent = await ctx.db
  .query('messages')
  .withIndex('by_channel', (q) =>
    q.eq('channel', channelId).gt('_creationTime', Date.now() - 60 * 60_000),
  )
  .collect();
```

## Compound index query

```ts
// Schema: .index("by_user_and_status", ["userId", "status"])
const activeTodos = await ctx.db
  .query('todos')
  .withIndex('by_user_and_status', (q) =>
    q.eq('userId', userId).eq('status', 'active'),
  )
  .order('desc')
  .take(50);
```

Compound indexes serve any prefix: `["userId", "status"]` works for queries that only constrain `userId`.

## Ordering and limits

```ts
const latest = await ctx.db.query('messages').order('desc').take(10);

// Top-N pattern — schema: .index("by_score", ["score"])
const topPlayers = await ctx.db
  .query('players')
  .withIndex('by_score')
  .order('desc')
  .take(10);
```

`.withIndex()` without a range expression scans the whole index — always pair with `.first()`, `.unique()`, `.take(n)`, or `.paginate()`. Never `.collect()` an unranged index on a non-trivial table.

## Single-document patterns

```ts
const task = await ctx.db.get(args.taskId); // by id

const profile = await ctx.db
  .query('profiles')
  .withIndex('by_user', (q) => q.eq('userId', userId))
  .unique(); // null if none, throws if multiple

const firstMatch = await ctx.db
  .query('messages')
  .withIndex('by_channel', (q) => q.eq('channel', channelId))
  .first();
```

## Joins

No SQL join. Write it in JS with `Promise.all`:

```ts
const attendees = await ctx.db
  .query('attendees')
  .withIndex('by_event', (q) => q.eq('eventId', args.eventId))
  .take(10_000);

const enriched = await Promise.all(
  attendees.map(async (a) => ({
    attendeeId: a._id,
    user: await ctx.db.get(a.userId),
  })),
);
```

## Aggregation and group-by

Fetch with an index, reduce in JS:

```ts
const grades = await ctx.db
  .query('grades')
  .withIndex('by_student', (q) => q.eq('studentId', args.studentId))
  .collect();

const avg = grades.reduce((s, g) => s + g.grade, 0) / grades.length;

const countBySubject: Record<string, number> = {};
for (const { subject } of grades) {
  countBySubject[subject] = (countBySubject[subject] ?? 0) + 1;
}
```

For high-throughput counters or sums over big tables, use the **Sharded Counter** or **Aggregate** components.

## Pagination

```ts
export const list = query({
  args: { channel: v.id('channels'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('messages')
      .withIndex('by_channel', (q) => q.eq('channel', args.channel))
      .order('desc')
      .paginate(args.paginationOpts);
  },
});
```

```tsx
const { results, status, loadMore } = usePaginatedQuery(
  api.messages.list,
  { channel: channelId },
  { initialNumItems: 20 },
);
```

## Conditional client query (skip)

```tsx
const todo = useQuery(api.todos.get, id ? { id } : 'skip');
```

## Reusing logic with helpers

Helpers take `QueryCtx` and stay inside `convex/`.

```ts
import { Id } from './_generated/dataModel';
import { query, QueryCtx } from './_generated/server';

async function getUserName(ctx: QueryCtx, userId: Id<'users'>) {
  const user = await ctx.db.get(userId);
  return user?.name ?? null;
}

export const getTaskWithAuthor = query({
  args: { id: v.id('tasks') },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task) return null;
    return { task, authorName: await getUserName(ctx, task.authorId) };
  },
});
```

## Index management

- Convex caps you at **32 indexes per table** and **16 fields per index**.
- **Removing an index from `schema.ts` deletes it on deploy** — make sure nothing queries it first.
- For large tables, use a **staged index** so backfill doesn't block deploy:

  ```ts
  defineTable({ channel: v.id('channels') }).index('by_channel', {
    fields: ['channel'],
    staged: true,
  });
  ```

  Wait for backfill in the dashboard, then remove `staged: true`.

## Limits

- Per query/mutation: ~**16,384 documents** read, **~8 MiB** scanned.
- Runtime budget: **~1 second**.
- Returned `undefined` → `null` on the client.
- Cross-type sort order: `undefined` < `null` < bigint < number < boolean < string < bytes < array < object.

## Quick decision table

| Need                           | Use                                                            |
| ------------------------------ | -------------------------------------------------------------- |
| One doc by id                  | `ctx.db.get(id)`                                               |
| One doc by unique field        | `withIndex(...).unique()`                                      |
| First match                    | `withIndex(...).first()`                                       |
| First N                        | `withIndex(...).take(n)`                                       |
| All in a tight range           | `withIndex(range).collect()`                                   |
| Streaming UI list              | `withIndex(...).paginate(opts)`                                |
| Top N by some field            | `withIndex("by_field").order("desc").take(n)`                  |
| External API call              | not a query — use an `action`                                  |
| Big aggregate / counter        | Aggregate or Sharded Counter component                         |
