---
name: convex-full-text-search
description: Use when implementing text search, search indexes, or search queries in Convex. Trigger on "search", "full-text search", "search index", "text search", "find by text", "typeahead", "search-as-you-type", or any feature that searches document content by keywords.
---

# Convex Full-Text Search

Reactive, transactional full-text search built on Tantivy. Results are returned in **relevance order** (BM25 + match proximity); ordering cannot be changed. The last term in a query is **prefix-matched**, making this ideal for as-you-type / typeahead search.

## Define a search index

```ts
// convex/schema.ts
messages: defineTable({
  body: v.string(),
  channel: v.string(),
  userId: v.id('users'),
}).searchIndex('search_body', {
  searchField: 'body', // exactly one, must be v.string()
  filterFields: ['channel'], // up to 16, any type
  // staged: true,                // optional: backfill async on deploy (large tables)
});
```

Nested fields use dot paths: `searchField: "properties.name"`.

## Query with search

```ts
export const search = query({
  args: { q: v.string(), channel: v.optional(v.string()) },
  handler: async (ctx, { q, channel }) => {
    return ctx.db
      .query('messages')
      .withSearchIndex('search_body', (s) =>
        channel
          ? s.search('body', q).eq('channel', channel)
          : s.search('body', q),
      )
      .take(10);
  },
});
```

The chained expression must be: **one `.search(...)`** followed by **zero or more `.eq(...)`** calls against `filterFields`. Use `q.eq("field", undefined)` to match documents missing a field.

## Combine with filters and pagination

Push as much filtering as possible into `.withSearchIndex` — extra `.filter(...)` runs _after_ the index lookup and is slower.

```ts
// Messages matching "hi" in the last 10 minutes
ctx.db
  .query('messages')
  .withSearchIndex('search_body', (s) => s.search('body', 'hi'))
  .filter((q) => q.gt(q.field('_creationTime'), Date.now() - 10 * 60_000))
  .take(10);

// Paginated search
ctx.db
  .query('messages')
  .withSearchIndex('search_body', (s) => s.search('body', q))
  .paginate(paginationOpts);
```

## Behavior

- **Tokenization:** lowercased, split on whitespace and punctuation. Terms capped at 32 chars. Best for English / Latin-script languages.
- **Prefix match:** only the _last_ term gets prefix matching. `"r"` matches `"rabbit"` and `"send request"`.
- **No fuzzy matching.** Typos won't match (`"stake"` won't find `"snake"`).
- **Ordering:** always by relevance. Ties broken by newest first. `.order()` is not supported on search queries.

## Limits

| Thing                                    | Limit     |
| ---------------------------------------- | --------- |
| Search field per index                   | exactly 1 |
| Filter fields per index                  | 16        |
| Terms (words) per query                  | 16        |
| Filter expressions per query             | 8         |
| Documents scanned per query              | 1024      |
| Indexes per table (search + db combined) | 32        |

`.collect()` throws if it would return more than 1024 docs — prefer `.take(n)` or `.paginate(...)`.

## Rules

- `searchField` must be a `v.string()` field.
- Search queries are reactive and transactional like any other Convex query.
- Multiple search indexes per table are allowed (they count toward the 32-index limit).
- For large tables, set `staged: true` so the deploy doesn't block on backfill.
