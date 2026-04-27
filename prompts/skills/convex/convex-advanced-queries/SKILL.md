---
name: convex-advanced-queries
description: Patterns for non-trivial Convex read queries — compound indexes, range filters, ordering and limits, joins, aggregations, group-by, pagination, and conditional client-side queries. Use this skill whenever writing or editing a Convex `query` function that does anything beyond a single `db.get()`, or whenever the user mentions "compound index", "withIndex", "order by", "take", "range query", "paginate", "join two tables", "aggregate", "group by", "skip query", `.filter()`, slow queries, full table scans, or read/write limit errors. Also trigger when reviewing schema indexes, picking the right index for a query, or fixing a query that's hitting Convex's 16k-document / 8 MiB / 1-second limits.
---

# Convex Advanced Queries

Convex queries are reactive, cached, and consistent — but only because the handler is **deterministic**. No `fetch`, no `Math.random()` from outside Convex's runtime, no current-time calls outside Convex's wrappers. If you need any of that, use an `action`, not a `query`.

## Core rule: indexes, not `.filter()`

`.filter()` does not use indexes. It walks every document in whatever range was already scanned. On any table that will grow past a few hundred rows, define an index in `convex/schema.ts` and use `.withIndex()`.

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

`_creationTime` is appended to **every** index automatically. Do not add it explicitly.

## Index range expressions

Inside `withIndex`, you must step through fields **in index order**:

1. Zero or more `.eq()` on the leading fields.
2. Optionally one range op (`.gt`/`.gte`/`.lt`/`.lte`) on the next field.
3. Nothing after a range op.

```ts
// Index: by_channel = ["channel"]  (+ implicit _creationTime)
const recent = await ctx.db
  .query('messages')
  .withIndex('by_channel', (q) =>
    q.eq('channel', channelId).gt('_creationTime', Date.now() - 60 * 60_000),
  )
  .collect();
```

You **cannot** range on a later field without `.eq()` on every earlier field — TypeScript will block it. If you need that shape, define a different index.

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

Compound indexes also serve any prefix: an index on `["userId", "status"]` works for queries that only constrain `userId`.

## Ordering and limits

Default order is `_creationTime` ascending. With `.withIndex()`, results are ordered by the index's fields, with `_creationTime` as the final tiebreaker.

```ts
const latest = await ctx.db.query('messages').order('desc').take(10);

// Top-N pattern: requires an index on the sort field.
// Schema: .index("by_score", ["score"])
const topPlayers = await ctx.db
  .query('players')
  .withIndex('by_score')
  .order('desc')
  .take(10);
```

When you call `.withIndex()` **without** a range expression, you are scanning the whole index. Always pair it with a limiter: `.first()`, `.unique()`, `.take(n)`, or `.paginate()`. Never `.collect()` an unranged index on a non-trivial table.

## Single-document patterns

```ts
// By id — fastest possible read.
const task = await ctx.db.get(args.taskId);

// By unique field via index.
const profile = await ctx.db
  .query('profiles')
  .withIndex('by_user', (q) => q.eq('userId', userId))
  .unique(); // null if none, throws if multiple

const firstMatch = await ctx.db
  .query('messages')
  .withIndex('by_channel', (q) => q.eq('channel', channelId))
  .first(); // null if none
```

## Joins

There is no SQL join. Write it in JS with `Promise.all` so the lookups run in parallel:

```ts
const attendees = await ctx.db
  .query('attendees')
  .withIndex('by_event', (q) => q.eq('eventId', args.eventId))
  .take(10_000); // safety cap

const enriched = await Promise.all(
  attendees.map(async (a) => ({
    attendeeId: a._id,
    user: await ctx.db.get(a.userId),
  })),
);
```

## Aggregation and group-by

Fetch with an index, then reduce in JS:

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

This only works while the index range fits inside Convex's read limits. For high-throughput counters, sums over big tables, or anything you'd otherwise re-scan on every read, use the **Sharded Counter** or **Aggregate** components instead of looping the table.

## Pagination

```ts
// Query
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
// Client
const { results, status, loadMore } = usePaginatedQuery(
  api.messages.list,
  { channel: channelId },
  { initialNumItems: 20 },
);
```

## Conditional client query (skip)

When the args aren't ready yet, pass `"skip"` so the hook doesn't fire and you don't get a transient error:

```tsx
const todo = useQuery(api.todos.get, id ? { id } : 'skip');
```

## Reusing logic with helpers

Helpers take `QueryCtx` and stay inside `convex/`. They are not callable from clients.

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

## Picking and changing indexes

- More specific range = faster query. If you can't add an `.eq()` and the table is large, add a new index.
- Convex caps you at **32 indexes per table** and **16 fields per index**. Every write updates every index, so don't define indexes you don't query.
- **Removing an index from `schema.ts` deletes it on deploy.** Make sure nothing queries it first.
- For a large table, use a **staged index** so the backfill doesn't block deploy:

  ```ts
  defineTable({ channel: v.id('channels') }).index('by_channel', {
    fields: ['channel'],
    staged: true,
  });
  ```

  Wait for backfill to complete in the dashboard, then remove `staged: true` to enable it.

## Limits to design around

- Per query/mutation: ~**16,384 documents** read and **~8 MiB** scanned.
- Runtime budget: **~1 second**.
- `undefined` returned from a query becomes `null` on the client — Convex values can't be `undefined`.
- Cross-type sort order on an indexed field: `undefined` < `null` < bigint < number < boolean < string < bytes < array < object. The same order applies to `gt/gte/lt/lte` on mixed-type fields.

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
| Filter that won't fit an index | `.filter()` _only_ after `.withIndex()` has narrowed the range |
| External API call              | not a query — use an `action`                                  |
| Big aggregate / counter        | Aggregate or Sharded Counter component                         |
