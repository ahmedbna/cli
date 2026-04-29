---
name: convex-pagination
description: Cursor-based reactive pagination with `paginate()` and `usePaginatedQuery` for infinite scroll and load-more patterns.
---

# Convex Pagination

Cursor-based, fully reactive. Backend returns `{ page, isDone, continueCursor }`; client uses `usePaginatedQuery`.

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

`paginationOptsValidator` validates the `{ numItems, cursor, ... }` arg — don't hand-roll it.

### With extra arguments

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

Map/filter `page` but keep `isDone` and `continueCursor` intact:

```ts
const results = await ctx.db.query('messages').paginate(paginationOpts);
return {
  ...results,
  page: results.page.map((m) => ({ ...m, body: m.body.toUpperCase() })),
};
```

### Capping page reads

Set `maximumBytesRead` and/or `maximumRowsRead` in page options to bound work per page.

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

Paginated queries are reactive: a page requested with 20 items may end up with 19 (deletion) or 21 (insertion). **Don't write UI logic that assumes constant page sizes.**

## Paginating manually (no React)

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

- `.paginate()` is **terminal** — don't chain `.collect()`/`.take()`/`.first()` after it.
- `.withIndex()`, `.withSearchIndex()`, `.filter()`, `.order()` go **before** `.paginate()`.
- Always use `paginationOptsValidator`.
- Pass other args via the second arg to `usePaginatedQuery` — **don't** include `paginationOpts`; the hook injects it.
