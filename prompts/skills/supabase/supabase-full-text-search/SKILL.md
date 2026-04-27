---
name: supabase-full-text-search
description: Use when implementing search over text columns in Supabase — searching posts, messages, products, users by name, etc. Trigger on "search", "ilike", "full text search", "tsvector", "tsquery", "to_tsvector", "websearch_to_tsquery", "GIN index", "trigram", "pg_trgm", "fuzzy search", "search bar", ".textSearch(", "ilike '%'", or any "find rows where text contains X" requirement. Especially trigger when ilike is being used on more than ~1000 rows.
---

# Supabase Full-Text Search

The default move — `ilike '%query%'` — works fine for the first 1,000 rows and dies the moment your `posts` table grows. Postgres has two excellent search systems and Supabase exposes both. Pick the right one and add the right index, or you're scanning the whole table on every keystroke.

## Decision tree (use this first)

| Query shape                                                                                  | Right tool                                 | Index                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------- |
| "Match these words/phrases, language-aware (stemming, stopwords)"                            | `tsvector` + `tsquery`                     | `GIN` on `tsvector`       |
| "Match a substring anywhere in a string" (e.g. usernames, file paths, partial product codes) | `pg_trgm` + `ilike` or `similarity()`      | `GIN` with `gin_trgm_ops` |
| "Fuzzy match with typo tolerance" (e.g. user typed "tehnology")                              | `pg_trgm` + `similarity()` or `%` operator | `GIN` with `gin_trgm_ops` |
| "Just search a small admin table" (<1k rows, rare query)                                     | Plain `ilike`                              | None                      |

Most apps want **`tsvector`** for the main search bar (posts, articles, descriptions) and **`pg_trgm`** for "search-as-you-type" usernames or product SKUs. They can coexist on the same table.

---

## Approach 1: Full-text search with `tsvector`

### The tsvector column

Don't compute `to_tsvector(...)` at query time — that scans every row. Materialize it as a generated column and index it:

```sql
-- supabase/migrations/0010_posts_search.sql

-- 1. Add a generated tsvector column. Postgres maintains it automatically.
alter table public.posts
  add column search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored;

-- 2. GIN index — required, this is what makes search fast.
create index posts_search_idx on public.posts using gin (search_vector);
```

**Three things that matter:**

- **`generated always as ... stored`** means postgres recomputes the vector on every insert/update. No triggers, no `update` worries.
- **`setweight(..., 'A')`** ranks title hits higher than body hits. `'A' > 'B' > 'C' > 'D'`. Use it whenever your text comes from multiple columns of different importance.
- **`'english'`** is the language config — drives stemming ("running" matches "run") and stop word removal ("the", "a"). Use `'simple'` for non-English or for strict matching (no stemming).

### Querying

The good API: `websearch_to_tsquery` — accepts the kind of input users actually type, including quoted phrases and `OR`:

```ts
const { data, error } = await supabase
  .from('posts')
  .select('*')
  .textSearch('search_vector', 'reactor "fuel rod" -coolant', {
    type: 'websearch',
    config: 'english',
  });
```

Other types (`plain`, `phrase`, `tsquery`) exist; **don't use `tsquery` directly with user input** — a stray `&` or `!` throws. `websearch` is forgiving:

| User typed        | Means                |
| ----------------- | -------------------- |
| `apple banana`    | both words           |
| `"apple banana"`  | exact phrase         |
| `apple OR banana` | either               |
| `apple -banana`   | apple but not banana |

### Ranking

Get matches in relevance order with `ts_rank`. Since the SDK's `.textSearch()` doesn't expose ranking directly, wrap it in an RPC:

```sql
create or replace function public.search_posts(_query text, _limit int default 20)
returns setof public.posts
language sql stable security invoker set search_path = public
as $$
  select p.*
  from public.posts p
  where p.search_vector @@ websearch_to_tsquery('english', _query)
  order by ts_rank(p.search_vector, websearch_to_tsquery('english', _query)) desc,
           p.created_at desc
  limit _limit;
$$;
```

```ts
const { data } = await supabase.rpc('search_posts', {
  _query: input,
  _limit: 20,
});
```

**RLS still applies** — even though this is a function, `security invoker` keeps it scoped to the user's permissions. Don't switch to `definer` to "make search faster" — you'll leak rows.

For ranked-and-highlighted results, add `ts_headline`:

```sql
returns table (id uuid, title text, snippet text, rank real) ... as $$
  select id, title,
         ts_headline('english', content, websearch_to_tsquery('english', _query),
                     'StartSel=<b>, StopSel=</b>, MaxFragments=2, MinWords=5, MaxWords=15'),
         ts_rank(search_vector, websearch_to_tsquery('english', _query))
    from posts
   where search_vector @@ websearch_to_tsquery('english', _query)
   order by 4 desc
   limit _limit;
$$;
```

`ts_headline` is **expensive** — it re-tokenizes the document. Only call it on the final `LIMIT`-ed result set, never on the underlying filter.

---

## Approach 2: Trigram search with `pg_trgm`

When `tsvector` is wrong: usernames (`@ahm` should match `@ahmed`), file paths, product codes, autocomplete. Stemming would tokenize "ahmed" weirdly; tsvector wants whole words.

```sql
-- One-time per database
create extension if not exists pg_trgm with schema extensions;

-- Index for fast ilike '%foo%' over the username column
create index users_username_trgm_idx
  on public.users
  using gin (username extensions.gin_trgm_ops);
```

Now `ilike` queries that previously did a sequential scan use the index:

```ts
const { data } = await supabase
  .from('users')
  .select('id, username')
  .ilike('username', `%${query}%`)
  .limit(20);
```

The exact same query, but now O(log n) instead of O(n). Run `explain analyze` to confirm — you should see `Bitmap Index Scan on users_username_trgm_idx` instead of `Seq Scan`.

### Fuzzy / typo-tolerant search

For "did you mean..." behavior, use the `%` operator (similarity threshold) or `similarity()` function:

```sql
-- Set similarity threshold per-session (default 0.3)
set pg_trgm.similarity_threshold = 0.3;

-- Or just call similarity() and order by it
select username, similarity(username, 'tehno') as sim
  from users
 where username % 'tehno'   -- similarity > threshold
 order by sim desc
 limit 10;
```

Wrap in an RPC for the client:

```sql
create or replace function public.search_users_fuzzy(_query text, _limit int default 10)
returns table (id uuid, username text, similarity real)
language sql stable security invoker set search_path = public, extensions
as $$
  select u.id, u.username,
         similarity(u.username, _query) as sim
    from public.users u
   where u.username % _query
   order by sim desc
   limit _limit;
$$;
```

```ts
const { data } = await supabase.rpc('search_users_fuzzy', { _query: input });
// data: [{ id, username, similarity }, ...]
```

---

## Combining: `tsvector` for body, `pg_trgm` for autocomplete

A real app usually wants both — main search uses tsvector for relevance, but the "search bar suggestions" while typing want trigrams for partial matches:

```sql
-- Main search: tsvector with weighted columns
alter table public.posts
  add column search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored;
create index posts_search_idx on public.posts using gin (search_vector);

-- Autocomplete: trigram on title only
create index posts_title_trgm_idx
  on public.posts using gin (title extensions.gin_trgm_ops);
```

Use the right one for the right interaction.

---

## Things that look like they should work and don't

### `select * from posts where to_tsvector('english', content) @@ ...` — slow

Doing `to_tsvector` at query time defeats the index. The index is on the _stored_ column. Always query against the materialized vector column.

### `ilike '%foo%'` without a trgm index on a 100k-row table

Sequential scan, every time. **Always check `explain` before shipping any search query** — if you see `Seq Scan` and the table will grow, you have a bomb on a timer.

### `ilike 'foo%'` (prefix only) — uses btree, but only with the right collation

A B-tree index supports prefix matches _if_ it was created with `text_pattern_ops`:

```sql
create index users_username_prefix_idx on public.users (username text_pattern_ops);
```

Without that operator class, the default index can't be used for `LIKE 'foo%'` even though it looks like it should. For autocomplete, prefer `pg_trgm` — it handles prefix, infix, and suffix.

### Searching a `jsonb` field with `ilike`

`ilike '%foo%'` against a jsonb column does a stringification per row. Slow and unindexable. For searchable jsonb keys, either:

- Materialize the searchable parts into their own column with a generated expression, then index that.
- Or use a `GIN` index on the jsonb column with `jsonb_path_ops` for membership queries (not great for substring).

### Phrase search on tsvector

`websearch_to_tsquery('english', '"red apple"')` matches the phrase "red apple" with stemming applied. If you need unstemmed exact phrase, use the `'simple'` config:

```sql
to_tsvector('simple', text)
```

But then "running" won't match "run". Trade-off.

---

## Multi-language search

If your content is mixed-language, two options:

1. **Single column, `'simple'` config**: no stemming, no stop words, just tokenization. Works across languages but you lose "search vs searching" matching.

2. **Per-language column with a `language` column**:

```sql
alter table public.posts add column language text not null default 'english';
alter table public.posts
  add column search_vector tsvector generated always as (
    case language
      when 'french' then to_tsvector('french', content)
      when 'spanish' then to_tsvector('spanish', content)
      else to_tsvector('english', content)
    end
  ) stored;
```

Postgres ships with configs for ~20 languages. Check `select cfgname from pg_ts_config;`.

---

## Hard rules

- **Don't `ilike '%foo%'` on a growing table without a trigram index.** It will be the slowest query in production and you won't notice until users complain.
- **Don't compute `to_tsvector(...)` at query time.** Always store and index it.
- **Don't pass user input to `to_tsquery`** — a stray special character throws. Use `websearch_to_tsquery`.
- **Don't use `ts_headline` on the unfiltered set.** Filter first, then headline only the result rows.
- **Don't switch your search RPC to `security definer` for performance.** You'll leak rows past RLS. The right fix is the index.
- **Don't forget the GIN index.** A `tsvector` column without a GIN index is no faster than `ilike`.
- **Don't use the wrong index operator class.** `gin_trgm_ops` for trigrams, `gin_jsonb_ops` for jsonb. The defaults aren't what you want.
- **Don't ship search without `explain analyze` on a realistic dataset size.** What works on 100 rows can be 30 seconds on 100k.

## Quick checklist for adding search

1. **Decide the model**: tsvector (whole-word, ranked) or pg_trgm (substring/fuzzy)?
2. **Add the column / extension** in a migration.
   - tsvector: generated stored column with `setweight(...)` per source field.
   - pg_trgm: `create extension`, then `gin (col gin_trgm_ops)` index.
3. **Index it.** Always. GIN index is the whole point.
4. **Wrap querying in an RPC** if you need ranking / highlighting / multi-condition logic.
5. **Test with `explain analyze`** at realistic scale. Confirm index usage.
6. **`npm run db:types`** to pick up the new RPC.
