---
name: supabase-database-functions
description: Use when writing Postgres functions, RPCs, atomic mutations, counters, triggers, or any logic that must run server-side rather than client-side. Trigger on "rpc", "supabase.rpc", "create function", "create or replace function", "atomic", "transaction", "race condition", "increment counter", "trigger", "before insert", "after update", "plpgsql", "security definer", "stored procedure", "database function", or any "the count is wrong sometimes" debugging.
---

# Supabase Database Functions (RPC)

For anything that's "read-modify-write" or "multi-step transaction," **don't do it from the client**. Two clients reading a counter, both incrementing in JS, both writing back, gives you `count + 1` instead of `count + 2`. Race conditions like this don't show up in dev — they show up the day you launch and your "likes" count starts going backwards.

The fix: write a Postgres function and call it via `supabase.rpc()`. One round-trip, atomic, RLS-aware, types generated automatically.

## When to use a database function

✅ **Atomic counters** (likes, views, balances).
✅ **Multi-table writes that must succeed together** (order + line items, user signup with team membership).
✅ **Logic that depends on data the client shouldn't see** (pricing rules, stock levels, secret config).
✅ **Aggregations the client would otherwise do in JS** (computing a leaderboard).
✅ **Authorization checks that involve joining tables** (`is_org_member`, `has_credits`).

**Don't** use them as a generic "API layer." Plain `from(...)` queries with RLS are simpler, type-safer, and faster to iterate on. Reach for RPC when you have a real reason.

## Anatomy

```sql
-- supabase/migrations/0008_increment_likes.sql
create or replace function public.increment_post_likes(_post_id uuid)
returns integer
language plpgsql
security invoker          -- run as the calling user (RLS applies)
set search_path = public  -- always, prevents schema injection
as $$
declare
  new_count integer;
begin
  -- Single statement does the read+write atomically
  update public.posts
     set like_count = like_count + 1
   where id = _post_id
   returning like_count into new_count;

  if new_count is null then
    raise exception 'Post not found' using errcode = 'P0001';
  end if;

  return new_count;
end;
$$;
```

Call from the client:

```ts
const { data, error } = await supabase.rpc('increment_post_likes', {
  _post_id: postId,
});
if (error) throw new ApiError(error.message, error.code, error);
// data: number — the new like count
```

`supabase gen types` picks this up — `data` is correctly typed as `number` and the args are typed too.

## `security invoker` vs `security definer` — get this right

The single most consequential decision per function.

| Mode                         | Runs as                                   | RLS applies           | When to use                                                                                                                                               |
| ---------------------------- | ----------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security invoker` (default) | The caller (`authenticated` user)         | Yes                   | Almost everything. Atomic mutations, counters, joins.                                                                                                     |
| `security definer`           | The function owner (typically `postgres`) | **No — bypasses RLS** | Only when you need to do something the user can't normally do (insert into a table with no INSERT policy, read another user's row to validate something). |

**Default to `security invoker`.** When you genuinely need `definer`, two non-negotiables:

1. **`set search_path = public`** (or whatever schemas you use). Without it, an attacker could create a `pg_temp.posts` table and your function uses theirs. Search-path injection is a real CVE class.
2. **Validate inputs aggressively.** A `definer` function with a SQL-injectable `format()` is a privilege escalation.

```sql
-- Safe definer pattern
create or replace function public.create_user_with_team(_team_name text)
returns uuid
language plpgsql
security definer              -- needed because INSERT on teams has no public policy
set search_path = public      -- non-negotiable
as $$
declare
  new_team_id uuid;
  user_id uuid := auth.uid();
begin
  -- ALWAYS check identity in security-definer functions
  if user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Validate inputs
  if length(_team_name) < 1 or length(_team_name) > 100 then
    raise exception 'Invalid team name';
  end if;

  insert into public.teams (name, owner_id) values (_team_name, user_id)
  returning id into new_team_id;

  insert into public.team_members (team_id, user_id, role)
  values (new_team_id, user_id, 'owner');

  return new_team_id;
end;
$$;

-- Lock down execute. Default GRANT EXECUTE TO PUBLIC is too generous.
revoke execute on function public.create_user_with_team(text) from public, anon;
grant execute on function public.create_user_with_team(text) to authenticated;
```

The `revoke … from public, anon` + `grant … to authenticated` pattern is what stops anonymous users from calling a privileged function. **Apply it to every `security definer` function.**

## Atomic increment — the canonical example

The race condition:

```ts
// BROKEN — race condition between read and write
const { data: post } = await supabase
  .from('posts')
  .select('like_count')
  .eq('id', id)
  .single();
await supabase
  .from('posts')
  .update({ like_count: post.like_count + 1 })
  .eq('id', id);
```

Two users tap "like" simultaneously: both read `5`, both write `6`. The fix has two valid forms — pick one.

### Fix 1: column expression (simple, no function needed)

```ts
// ✅ Single statement, atomic at the row level
const { error } = await supabase.from('posts').update({
  like_count: supabase.rpc('like_count + 1' /* won't work, just for shape */),
});
```

The `from(...).update()` API doesn't actually let you write `column = column + 1` — that's a SQL expression, and the SDK only accepts values. So in practice you need...

### Fix 2: RPC (works, atomic, the standard pattern)

```sql
create or replace function public.increment_post_likes(_post_id uuid)
returns integer language plpgsql security invoker set search_path = public as $$
declare new_count integer;
begin
  update public.posts set like_count = like_count + 1
   where id = _post_id returning like_count into new_count;
  return new_count;
end;
$$;
```

```ts
const { data: newCount, error } = await supabase.rpc('increment_post_likes', {
  _post_id: postId,
});
```

The `update ... returning` is one statement, one row-lock, fully atomic. RLS still applies — if the user can't update the post, the function returns null/errors.

## Multi-table transactions

Wrap multiple writes in a function and they're automatically transactional — postgres rolls back if any statement fails:

```sql
create or replace function public.create_post_with_tags(
  _content text,
  _tags text[]
)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  user_id uuid := auth.uid();
  new_post_id uuid;
  tag text;
begin
  if user_id is null then raise exception 'Not authenticated'; end if;

  insert into public.posts (author_id, content) values (user_id, _content)
  returning id into new_post_id;

  foreach tag in array _tags loop
    insert into public.post_tags (post_id, tag) values (new_post_id, tag);
  end loop;

  return new_post_id;
end;
$$;
```

If any tag insert fails (constraint violation, RLS reject, etc.), the post insert rolls back too. Try doing this from the client and you'll have orphaned posts the day a tag table policy changes.

## Triggers — for invariants you can't trust the client to maintain

Triggers run on every row change and let you enforce rules at the database level. Common uses:

- `updated_at` column (already in the BNA template via `set_updated_at()`).
- Denormalized counters (`comment_count` on posts, kept in sync as comments are added/deleted).
- Audit logs.
- Auto-create related rows (the `handle_new_user` trigger).

```sql
-- Maintain a denormalized comment count on posts
create or replace function public.update_post_comment_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (TG_OP = 'INSERT') then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif (TG_OP = 'DELETE') then
    update public.posts set comment_count = comment_count - 1 where id = old.post_id;
  end if;
  return null;  -- AFTER triggers ignore the return value
end;
$$;

create trigger comments_count_sync
  after insert or delete on public.comments
  for each row execute function public.update_post_comment_count();
```

`security definer` is correct here — the trigger needs to update `posts` regardless of whether the comment author has UPDATE rights on posts.

**Trigger gotchas:**

- `before` triggers can mutate `new.*` and return it. `after` triggers can't.
- Returning `null` from a `before` trigger **cancels the operation silently**. Easy way to introduce "writes that don't actually happen."
- Triggers fire per-row by default. For bulk operations, that gets slow — `for each statement` triggers fire once per query.
- Trigger functions can't see the calling user's JWT directly via `auth.uid()` if invoked through `service_role` paths. Inside the trigger, `auth.uid()` returns whatever the authenticated session is, including null for service-role contexts.

## Function arguments — naming and types

Use `_` prefixes (`_post_id`, `_content`) to distinguish args from column names. Without that, `where id = post_id` becomes ambiguous:

```sql
-- ambiguous: is post_id the column or the argument?
create function get_post(post_id uuid) returns ... as $$
  select * from posts where id = post_id;
$$;

-- ✅ clear
create function get_post(_post_id uuid) returns ... as $$
  select * from posts where id = _post_id;
$$;
```

For nullable args, postgres requires `default null`:

```sql
create function search_posts(_query text, _author_id uuid default null)
returns setof posts language sql security invoker set search_path = public as $$
  select * from posts
   where content ilike '%' || _query || '%'
     and (_author_id is null or author_id = _author_id);
$$;
```

Call from JS, omit the optional arg:

```ts
const { data } = await supabase.rpc('search_posts', { _query: 'hello' });
```

## Returning data — three common shapes

```sql
-- 1. Scalar value
returns integer  -- returns a single number; client gets `data: number`

-- 2. Single row
returns posts    -- returns a posts row; client gets `data: Post`

-- 3. Multiple rows
returns setof posts             -- client gets `data: Post[]`
returns table (id uuid, count int)  -- ad-hoc shape; client gets typed array
```

For complex shapes, `returns table` keeps it readable:

```sql
create function get_user_stats(_user_id uuid)
returns table (post_count int, total_likes int, joined_at timestamptz)
language sql security invoker set search_path = public as $$
  select count(*)::int,
         sum(like_count)::int,
         (select created_at from users where id = _user_id)
  from posts where author_id = _user_id;
$$;
```

`supabase gen types` picks up the return shape — `data` is `Array<{ post_count: number; total_likes: number; joined_at: string }>`.

## Error handling

Throw with explicit codes so the client can branch:

```sql
raise exception 'Insufficient credits' using errcode = 'P0002';
raise exception 'Not authenticated'    using errcode = '42501';  -- standard "insufficient privilege"
```

In JS:

```ts
const { data, error } = await supabase.rpc('spend_credits', { _amount: 100 });
if (error) {
  if (error.code === 'P0002') {
    showUpgradePrompt();
    return;
  }
  throw error;
}
```

PostgreSQL reserves `P0001` for generic plpgsql exceptions. Use `P0002`, `P0003`, etc. for app-specific codes, or use the standard SQLSTATE codes when they fit.

## Hard rules

- **Don't read-then-write from the client for counters / balances / anything contended.** Always RPC.
- **Don't default to `security definer`.** It bypasses RLS. Only use it when the user genuinely can't perform the operation under their own role.
- **Don't write a `security definer` function without `set search_path = public`.** Search-path injection is a real attack class.
- **Don't write a `security definer` function without `revoke execute … from public, anon`** unless you intend it to be callable unauthenticated.
- **Don't use `auth.uid()` as a default argument value.** It's evaluated at function-creation time, not call time. Use `coalesce(_user_id, auth.uid())` inside the body instead.
- **Don't return `null` from a `before` trigger by accident.** It cancels the operation. Always `return new;` (or `return old;` for DELETE) unless you specifically want to block it.
- **Don't use functions for trivial CRUD.** RLS-protected `from(...)` calls are simpler, safer, and don't need a migration to change.
- **Don't forget `set search_path` in any function.** Make it muscle memory.
- **Don't forget to regenerate types after adding a function.** `npm run db:types`.

## Quick checklist for a new function

1. **Is this really needed?** If a single-table mutation works under RLS, skip the function.
2. **`security invoker` or `definer`?** Default to invoker. Definer only with explicit reason.
3. **`set search_path = public`** — always.
4. **Validate `auth.uid()` at the top** if it's a definer function or an authenticated-only operation.
5. **Use `_` prefixes for arguments** (`_post_id`, not `post_id`).
6. **`returns ...` matches what you actually return.** The type generator depends on it.
7. **For definer functions:** `revoke execute from public, anon` + `grant execute to authenticated`.
8. **`raise exception` with explicit `errcode`** so the client can branch on errors.
9. **Add a migration** (don't edit in Studio).
10. **`npm run db:types`** after applying.
