---
name: convex-pagination
description: Use when implementing paginated queries, infinite scroll, load-more patterns, or fetching all rows of a large table from Convex. Trigger on "pagination", "paginate", "infinite scroll", "load more", "usePaginatedQuery", "FlatList pagination", "cursor", or any query returning results in pages.
---

# Convex Pagination

Cursor-based, fully reactive pagination. The backend returns a `{ page, isDone, continueCursor }` shape; on the client, `usePaginatedQuery` manages cursors for you.

## Backend — paginated query

```ts
// convex/messages.ts
import { v } from 'convex/values';
import { query } from './_generated/server';
import { paginationOptsValidator } from 'convex/server';

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) =>
    ctx.db.query('messages').order('desc').paginate(paginationOpts),
});
```

`paginationOptsValidator` validates the `{ numItems, cursor, ... }` arg the client sends — don't hand-roll it.

### With extra arguments

The query can take any other args alongside `paginationOpts`:

```ts
export const listByAuthor = query({
  args: { paginationOpts: paginationOptsValidator, author: v.string() },
  handler: async (ctx, { paginationOpts, author }) =>
    ctx.db
      .query('messages')
      .withIndex('by_author', (q) => q.eq('author', author))
      .order('desc')
      .paginate(paginationOpts),
});
```

### Transforming the page

Map/filter the `page` array but keep `isDone` and `continueCursor` intact:

```ts
const results = await ctx.db.query('messages').paginate(paginationOpts);
return {
  ...results,
  page: results.page.map((m) => ({ ...m, body: m.body.toUpperCase() })),
};
```

### Capping page reads

To bound work per page, set `maximumBytesRead` and/or `maximumRowsRead` in the page options. If a page would exceed them, Convex returns a status that tells the client to split the page — no code change needed on the client.

## Frontend — `usePaginatedQuery`

```tsx
import { usePaginatedQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';

function MessageList() {
  const { results, status, isLoading, loadMore } = usePaginatedQuery(
    api.messages.list,
    {}, // other args (excluding paginationOpts)
    { initialNumItems: 20 },
  );

  return (
    <FlatList
      data={results}
      renderItem={({ item }) => <MessageRow message={item} />}
      onEndReached={() => {
        if (status === 'CanLoadMore') loadMore(20);
      }}
      onEndReachedThreshold={0.5}
      ListFooterComponent={status === 'LoadingMore' ? <Spinner /> : null}
    />
  );
}
```

### Status values

| Status               | Meaning                                   |
| -------------------- | ----------------------------------------- |
| `"LoadingFirstPage"` | First page hasn't arrived yet             |
| `"CanLoadMore"`      | More items available — call `loadMore(n)` |
| `"LoadingMore"`      | A `loadMore` call is in flight            |
| `"Exhausted"`        | No more items                             |

`loadMore(n)` is a no-op unless `status === "CanLoadMore"`.

## Reactivity caveat — page sizes can change

Paginated queries are **fully reactive**: if a row in any already-loaded page is inserted, deleted, or modified, that page rerenders. Consequence: **a page you requested with 20 items may end up with 19 (deletion) or 21 (insertion).** Don't write UI logic that assumes page sizes stay constant.

## Paginating manually (no React)

For scripts, server jobs, or exporting the full table — loop over pages until `isDone`:

```ts
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';

const client = new ConvexHttpClient(process.env.VITE_CONVEX_URL!);

async function getAll() {
  const results = [];
  let cursor: string | null = null;
  let isDone = false;

  while (!isDone) {
    const page = await client.query(api.messages.list, {
      paginationOpts: { numItems: 100, cursor },
    });
    results.push(...page.page);
    cursor = page.continueCursor;
    isDone = page.isDone;
  }
  return results;
}
```

## Rules

- `.paginate(paginationOpts)` is a **terminal** call — don't chain `.collect()` / `.take()` / `.first()` after it.
- `.withIndex()`, `.withSearchIndex()`, `.filter()`, and `.order()` all go **before** `.paginate()`.
- Always use `paginationOptsValidator` for the arg — it handles the cursor protocol.
- Pass other args via the second arg to `usePaginatedQuery` — **don't** include `paginationOpts` there; the hook injects it.
- Use `loadMore` on `onEndReached` for infinite scroll, or behind a "Load More" button.
