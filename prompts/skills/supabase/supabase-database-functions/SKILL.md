---
name: supabase-database-functions
description: Postgres functions and RPCs for atomic mutations, counters, multi-table transactions, and triggers. Avoid client-side read-modify-write race conditions.
---

# Supabase Database Functions (RPC)

For "read-modify-write" or multi-step transactions, write a Postgres function and call via `supabase.rpc()`. Atomic, RLS-aware, types generated.

## When to use

- **Atomic counters** (likes, views, balances).
- **Multi-table writes that must succeed together** (order + line items).
- **Logic depending on data the client shouldn't see** (pricing, stock).
- **Aggregations** (leaderboards).
- **Authorization checks involving joins** (`is_org_member`, `has_credits`).

**Don't** use as a generic API layer — plain `from(...)` queries with RLS are simpler.

## Anatomy

```sql
-- supabase/migrations/0008_increment_likes.sql
create or replace function public.increment_post_likes(_post_id uuid)
returns integer
language plpgsql
security invoker          -- RLS applies (default)
set search_path = public  -- always, prevents schema injection
as $$
declare
  new_count integer;
begin
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

```ts
const { data, error } = await supabase.rpc('increment_post_likes', {
  _post_id: postId,
});
if (error) throw new ApiError(error.message, error.code, error);
// data: number
```

## `security invoker` vs `security definer`

| Mode                         | Runs as                | RLS applies           | When to use                                                              |
| ---------------------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------ |
| `security invoker` (default) | The caller             | Yes                   | Almost everything.                                                       |
| `security definer`           | The function owner     | **No — bypasses RLS** | When the user genuinely can't do the operation under their own role.    |

**Default to `security invoker`.** When using `definer`:

1. **`set search_path = public`** — non-negotiable.
2. **Validate inputs.** SQL-injectable `format()` is a privilege escalation.
3. **Lock down execute**:

```sql
-- Safe definer pattern
create or replace function public.create_user_with_team(_team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_team_id uuid;
  user_id uuid := auth.uid();
begin
  if user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

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

revoke execute on function public.create_user_with_team(text) from public, anon;
grant execute on function public.create_user_with_team(text) to authenticated;
```

## Atomic increment

The race condition:

```ts
// BROKEN — race between read and write
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

The fix — RPC with `update ... returning`:

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

## Multi-table transactions

Wrapping multiple writes makes them transactional — postgres rolls back on any failure:

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

## Triggers — invariants you can't trust the client to maintain

```sql
-- Maintain denormalized comment count
create or replace function public.update_post_comment_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (TG_OP = 'INSERT') then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif (TG_OP = 'DELETE') then
    update public.posts set comment_count = comment_count - 1 where id = old.post_id;
  end if;
  return null;  -- AFTER triggers ignore return value
end;
$$;

create trigger comments_count_sync
  after insert or delete on public.comments
  for each row execute function public.update_post_comment_count();
```

**Trigger gotchas:**
- `before` triggers can mutate `new.*`. `after` cannot.
- Returning `null` from `before` **silently cancels** the operation.
- Per-row by default. For bulk, use `for each statement`.
- `auth.uid()` returns null for service-role contexts.

## Function arguments

Use `_` prefixes (`_post_id`) to disambiguate from columns:

```sql
-- ambiguous
create function get_post(post_id uuid) returns ... as $$
  select * from posts where id = post_id;
$$;

-- clear
create function get_post(_post_id uuid) returns ... as $$
  select * from posts where id = _post_id;
$$;
```

Nullable args need `default null`:

```sql
create function search_posts(_query text, _author_id uuid default null)
returns setof posts language sql security invoker set search_path = public as $$
  select * from posts
   where content ilike '%' || _query || '%'
     and (_author_id is null or author_id = _author_id);
$$;
```

```ts
const { data } = await supabase.rpc('search_posts', { _query: 'hello' });
```

## Return shapes

```sql
returns integer  -- scalar; client gets `data: number`
returns posts    -- single row; client gets `data: Post`
returns setof posts                  -- client gets `data: Post[]`
returns table (id uuid, count int)   -- ad-hoc shape; typed array
```

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

## Error handling

```sql
raise exception 'Insufficient credits' using errcode = 'P0002';
raise exception 'Not authenticated'    using errcode = '42501';
```

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

Use `P0002`, `P0003`, etc. for app-specific codes.

## Hard rules

- **Don't read-then-write from client for counters/balances** — always RPC.
- **Don't default to `security definer`** — it bypasses RLS.
- **Don't write `security definer` without `set search_path = public`.**
- **Don't write `security definer` without `revoke execute … from public, anon`** unless intentionally unauthenticated.
- **Don't use `auth.uid()` as default arg** — evaluated at creation, not call. Use `coalesce(_user_id, auth.uid())` inside.
- **Don't return `null` from `before` trigger by accident** — silently cancels.
- **Don't use functions for trivial CRUD.**
- **Don't forget `set search_path` in any function.**
- **Don't forget `npm run db:types` after adding a function.**

## New function checklist

1. Is this needed? Skip if RLS-protected `from(...)` works.
2. `security invoker` (default) or `definer`?
3. `set search_path = public` always.
4. Validate `auth.uid()` at top for definer/auth-only.
5. `_` prefixes for arguments.
6. `returns ...` matches actual shape.
7. For definer: `revoke execute from public, anon` + `grant to authenticated`.
8. `raise exception` with explicit `errcode`.
9. Add a migration (don't edit in Studio).
10. `npm run db:types` after applying.
