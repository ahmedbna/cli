---
name: supabase-pagination
description: Use when implementing pagination, infinite scroll, "load more" buttons, or any list that doesn't render every row at once. Trigger on "pagination", ".range(", "limit", "offset", "infinite scroll", "FlatList onEndReached", "load more", "page", "nextCursor", "keyset pagination", "cursor pagination", "useInfiniteQuery", "duplicate rows in list", "missing rows", or any list view in Expo that loads N at a time.
---

# Supabase Pagination

Two pagination strategies. **Pick the right one or your list will quietly show duplicates and gaps in production.**

| Strategy                 | When to use                                                                        | API                                     |
| ------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------- |
| **Offset / page-number** | Static, slow-changing data; admin tables; jumping to "page 47"; total count needed | `.range(start, end)`                    |
| **Cursor / keyset**      | Feeds, infinite scroll, anything ordered by `created_at` that gets new rows        | `.lt('created_at', last)` + `.limit(N)` |

## The bug everyone hits with offset pagination

```ts
// Looks fine. Breaks in production.
const PAGE = 20;
const { data } = await supabase
  .from('posts')
  .select('*')
  .order('created_at', { ascending: false })
  .range(page * PAGE, page * PAGE + PAGE - 1);
```

Symptoms when this is wired into infinite scroll:

- **Duplicates in the list.** Page 0 fetches rows 0–19. While the user scrolls, a new row gets inserted. Page 1 fetches rows 20–39 — but now what was row 19 is row 20, so it appears in both pages.
- **Missing rows.** Same setup, but a row gets deleted between page 0 and page 1. Page 1 starts at the _new_ row 20, skipping the one that shifted up.
- **Slow at scale.** `OFFSET 10000` makes Postgres count past 10,000 rows just to throw them away. Linear in the offset, regardless of indexes.

The fix: cursor pagination. Don't ask "give me page 5" — ask "give me 20 rows after this specific row."

## Cursor pagination — the default for feeds

Order by an immutable, indexed column (`created_at`, or better, a `(created_at, id)` composite). Use the last row's value as the cursor:

```ts
async function listPosts({ before }: { before?: string }) {
  let query = supabase
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw new ApiError(error.message, error.code, error);

  return {
    posts: data ?? [],
    nextCursor:
      data && data.length === 20 ? data[data.length - 1].created_at : null, // null = no more pages
  };
}
```

Caller:

```ts
// First page
const page1 = await listPosts({});
// Next page
const page2 = await listPosts({ before: page1.nextCursor! });
```

### Tie-breaker for collisions

`created_at` is `timestamptz` — usually unique enough, but two rows inserted in the same millisecond are possible. Without a tie-breaker, you may skip or duplicate rows when the cursor lands on a tie.

The robust pattern: order by `(created_at, id)` and use a compound cursor:

```sql
-- One-time index
create index posts_created_at_id_idx on public.posts (created_at desc, id desc);
```

```ts
async function listPosts({
  before,
}: {
  before?: { created_at: string; id: string };
}) {
  let query = supabase
    .from('posts')
    .select('*')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(20);

  if (before) {
    // "rows older than the cursor" expressed as compound comparison:
    // created_at < cursor.created_at OR (created_at = cursor.created_at AND id < cursor.id)
    query = query.or(
      `created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`,
    );
  }

  const { data } = await query;
  return {
    posts: data ?? [],
    nextCursor:
      data && data.length === 20
        ? { created_at: data.at(-1)!.created_at, id: data.at(-1)!.id }
        : null,
  };
}
```

For most apps, plain `created_at` is fine — only get fancy with the compound cursor when you actually see ties (high-write systems, bulk imports, replicated data).

## With TanStack Query's `useInfiniteQuery`

This is what every "feed" screen ends up using. The shape `useInfiniteQuery` expects matches what `listPosts` returns above:

```tsx
import { useInfiniteQuery } from '@tanstack/react-query';
import { FlatList } from 'react-native';

export function FeedScreen() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: ['posts', 'feed'],
      queryFn: ({ pageParam }) => api.posts.list({ before: pageParam }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    });

  // Flatten pages into one array for the list
  const posts = data?.pages.flatMap((p) => p.posts) ?? [];

  return (
    <FlatList
      data={posts}
      keyExtractor={(p) => p.id}
      renderItem={({ item }) => <PostRow post={item} />}
      onEndReached={() => {
        if (hasNextPage && !isFetchingNextPage) fetchNextPage();
      }}
      onEndReachedThreshold={0.5}
      ListFooterComponent={isFetchingNextPage ? <Spinner /> : null}
      refreshing={isLoading}
    />
  );
}
```

`onEndReachedThreshold={0.5}` triggers the fetch when the user is half a screen from the bottom — feels native. Lower values feel sluggish.

## Offset pagination — when it's fine

For admin tables, "results 1-20 of 1,250", or any UI showing a total count and page-number controls. Static data. Small offsets (single-digit page count).

```ts
async function getUsersPage(page: number, pageSize = 20) {
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data, count, error } = await supabase
    .from('users')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new ApiError(error.message, error.code, error);
  return { users: data ?? [], total: count ?? 0 };
}
```

`{ count: 'exact' }` runs a separate `COUNT(*)` query. Three options:

| Option        | Cost                                        | Use when                              |
| ------------- | ------------------------------------------- | ------------------------------------- |
| `'exact'`     | Slow on big tables (full count)             | Small / medium tables                 |
| `'planned'`   | Fast, approximate (uses pg_class.reltuples) | Large tables, fuzzy total OK          |
| `'estimated'` | Fast, more accurate than planned            | Same as above, slightly more accurate |
| omit          | Free                                        | When you don't need a total           |

For a `posts` feed of 10M rows, never `count: 'exact'` — it scans the whole table. For a 50-row admin page, fine.

## Range with no upper bound

`range(start, end)` is **inclusive on both ends**. To get rows 100 onward without a fixed page size:

```ts
.range(100, 100 + 999) // capped at 1000 by default in postgrest
```

Postgrest enforces `max_rows` (default 1000 on Supabase). Above that, even an unbounded range silently truncates. Cursor-based pagination with smaller limits is the only sane way to walk a large dataset.

## Realtime feeds — pagination + new rows arriving

Combine cursor pagination (load older posts) with realtime (prepend new posts as they're created):

```tsx
const { data, fetchNextPage, hasNextPage } = useInfiniteQuery({
  queryKey: ['posts', 'feed'],
  queryFn: ({ pageParam }) => api.posts.list({ before: pageParam }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
});

useEffect(() => {
  const channel = supabase
    .channel('posts:feed')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'posts' },
      (payload) => {
        // Prepend the new post to the first page
        queryClient.setQueryData(['posts', 'feed'], (old: any) => {
          if (!old) return old;
          const [first, ...rest] = old.pages;
          return {
            ...old,
            pages: [
              { ...first, posts: [payload.new, ...first.posts] },
              ...rest,
            ],
          };
        });
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}, []);
```

See the `supabase-realtime-advanced` skill for the rest of the lifecycle rules.

## Don't use `LIMIT/OFFSET` for "load more" feeds

To restate it because this is the most common failure: in any UI where new rows appear over time (feeds, notifications, comments, chat history, anything ordered by `created_at`), do not use offset pagination. The drift is silent — duplicates and gaps look like a bug in your render code, you'll spend hours on it, and the answer is "you used the wrong pagination strategy."

Cursor pagination is one extra line of code (`.lt('created_at', cursor)`), with no downside for those use cases.

## `range` translates to `OFFSET`/`LIMIT` under the hood

Just so it's clear what's happening:

```ts
.range(100, 119)
// becomes: ... LIMIT 20 OFFSET 100
```

So the same offset-drift problem applies to `.range()`. Cursor pagination uses `.lt()` / `.gt()` filters with `.limit()` instead.

## Hard rules

- **Don't use `OFFSET` / `.range()` for feeds.** Cursor pagination only, for anything that grows over time.
- **Don't paginate without an `order by`.** Without it, postgres can return rows in any order — pages overlap.
- **Don't order by a non-indexed column.** Search is slow, but pagination by a non-indexed column means each page is a full scan.
- **Don't use `count: 'exact'` on big tables.** It's a full table scan. Use `'estimated'` or omit it.
- **Don't paginate `.select('*')`** when you display 3 fields. Each request pays full row cost over the wire.
- **Don't forget RLS in your reasoning.** Pagination respects RLS — if a user can't see 5 of the 20 rows in a page, they get 15 back, not 20. Always over-fetch slightly or accept short pages on the boundary.
- **Don't fetch the next page if `data.length < pageSize`.** That means you've hit the end. Persist `nextCursor: null` and `hasNextPage: false`.
- **Don't trigger `fetchNextPage` while `isFetchingNextPage`.** `FlatList`'s `onEndReached` can fire repeatedly as the user wiggles. Always guard.
- **Don't sort client-side after fetching.** If you need a different order, change the query — sorting in JS only sorts the loaded slice and breaks once you paginate.

## Quick checklist for a new paginated list

1. **Pick strategy**: cursor for feeds, offset for admin / page-number UIs.
2. **Index the order column.** `create index posts_created_at_idx on posts (created_at desc);`
3. **For cursor**: query takes `before?` arg, returns `{ posts, nextCursor }`.
4. **For offset**: include `count` only if you actually display "X of Y", and pick `'exact'` only if the table is small.
5. **Wire to `useInfiniteQuery`** with `getNextPageParam: (last) => last.nextCursor ?? undefined`.
6. **`FlatList` with `onEndReached`** + threshold of `0.5`, guarded by `hasNextPage && !isFetchingNextPage`.
7. **Realtime** for "new rows arriving" — prepend in the first page of the cache.
