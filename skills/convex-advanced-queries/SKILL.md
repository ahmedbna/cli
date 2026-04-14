---
name: convex-advanced-queries
description: Use when implementing compound index queries, ordering, limiting, range filters, or conditional queries in Convex. Trigger on "compound index", "order by", "take", "range query", "conditional query", "skip query", or complex read patterns beyond basic get/list.
---

# Convex Advanced Queries

## Order and limit

```ts
const latest = await ctx.db.query("messages").order("desc").take(10);
```

## Filter by index with range

```ts
const recent = await ctx.db.query("messages")
  .withIndex("by_creation_time", q =>
    q.gt("_creationTime", Date.now() - 3600_000)
  )
  .collect();
```

## Compound index query

Define a compound index in your schema, then query with multiple equality checks:

```ts
// Schema: .index("by_user_and_status", ["userId", "status"])
const activeTodos = await ctx.db.query("todos")
  .withIndex("by_user_and_status", q =>
    q.eq("userId", userId).eq("status", "active")
  )
  .order("desc")
  .take(50);
```

## Get a single document by index

```ts
const profile = await ctx.db.query("profiles")
  .withIndex("by_user", q => q.eq("userId", userId))
  .unique(); // returns null if not found, throws if multiple
```

## Conditional query (skip)

On the frontend, use `"skip"` to avoid running a query when args aren't ready:

```tsx
const todo = useQuery(api.todos.get, id ? { id } : "skip");
```

## Rules

- NEVER use `.filter()` — always define and use indexes
- `.unique()` → single doc or null (throws on multiple)
- `.collect()` → all matching docs as array
- `.take(n)` → first n matching docs
- `.first()` → first matching doc or null
- Queries read at most 16384 documents and 8 MiB
- Query/mutation timeout is 1 second
