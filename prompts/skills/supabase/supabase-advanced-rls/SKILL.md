---
name: supabase-advanced-rls
description: Use when writing or auditing Row Level Security policies in Supabase — multi-tenant access, role-based permissions, JWT claims, helper functions, performance tuning, or debugging "row returns empty but data exists". Trigger on "RLS", "row level security", "policy", "auth.uid()", "auth.jwt()", "USING", "WITH CHECK", "FOR SELECT", "FOR INSERT", "security definer", "permission denied", "anon role", "authenticated role", "service_role", "tenant", "organization", "team membership", or any postgres policy work.
---

# Supabase Advanced RLS

The anon key is shipped to every client. **Every public table needs RLS or it's a public data leak.** RLS in Supabase isn't optional security — it _is_ your authorization layer. The `if (!userId) throw` guard you'd write in Convex becomes a SQL policy here. Get this wrong and the failure mode is silent: queries return `[]` instead of erroring, so bugs ship.

## The mental model

A policy is a `WHERE` clause that postgres silently AND-s into every query against a table. With RLS on:

- `select` returns only rows where the policy's `USING` clause is true.
- `insert` succeeds only if the new row satisfies `WITH CHECK`.
- `update` requires `USING` to match the **old** row AND `WITH CHECK` to match the **new** row.
- `delete` requires `USING` to match.

If no policy matches, the row is invisible / the write fails. **Silently.** No error, just empty results. This is the #1 cause of "my insert worked but the query returns nothing" — the insert went through but the SELECT policy is missing.

## Always enable RLS, always

```sql
alter table public.posts enable row level security;
```

Then add policies. The `scripts/check-rls.js` guard from the BNA template fails CI if any public table has RLS off — wire it into `db:push:safe` and forget about it.

## The four operations need separate policies

A common mistake: writing one `for all` policy and assuming it covers everything. It does, but `with check` and `using` get tangled and you can't reason about it. Be explicit:

```sql
alter table public.posts enable row level security;

-- Read: any authenticated user can see all posts
create policy "posts_select_authed" on public.posts
  for select using (auth.uid() is not null);

-- Insert: must be the author
create policy "posts_insert_own" on public.posts
  for insert with check (auth.uid() = author_id);

-- Update: only your own row, can't change author_id away from yourself
create policy "posts_update_own" on public.posts
  for update
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

-- Delete: only your own
create policy "posts_delete_own" on public.posts
  for delete using (auth.uid() = author_id);
```

The `with check` on UPDATE is what stops a user from updating their post and changing `author_id` to someone else's id. Without it, ownership transfers are possible.

## Multi-tenant: organizations / teams

The pattern that scales. A `members` join table maps users to orgs, and every per-org table checks membership.

```sql
create table public.organizations (
  id uuid primary key default extensions.uuid_generate_v4(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  primary key (org_id, user_id)
);

alter table public.organizations enable row level security;
alter table public.org_members   enable row level security;
```

Now every per-org table joins through `org_members`. **But** if you write the join inline in every policy, it gets slow and unreadable:

```sql
-- Slow + repetitive — don't do this for every table
create policy "documents_member" on public.documents
  for select using (
    exists (
      select 1 from public.org_members
      where org_members.org_id = documents.org_id
        and org_members.user_id = auth.uid()
    )
  );
```

Pull it into a helper function. Mark it `stable` and `security definer` so postgres can cache the result per query and bypass RLS on the lookup itself:

```sql
create or replace function public.is_org_member(_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where org_id = _org_id and user_id = auth.uid()
  );
$$;

-- Now every policy is a one-liner:
create policy "documents_select_member" on public.documents
  for select using (public.is_org_member(org_id));

create policy "documents_insert_member" on public.documents
  for insert with check (public.is_org_member(org_id));
```

Add a role check helper too:

```sql
create or replace function public.has_org_role(_org_id uuid, _roles text[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where org_id = _org_id and user_id = auth.uid() and role = any(_roles)
  );
$$;

create policy "documents_delete_admin" on public.documents
  for delete using (public.has_org_role(org_id, array['owner', 'admin']));
```

## Performance: the wrap-in-select trick

`auth.uid()` runs **once per row** by default. On a 10k row table that's 10k function calls. Wrap it in a scalar subquery and postgres evaluates it once for the whole query:

```sql
-- Slow: auth.uid() called per row
create policy "p_slow" on public.posts
  for select using (auth.uid() = author_id);

-- Fast: evaluated once, then compared
create policy "p_fast" on public.posts
  for select using ((select auth.uid()) = author_id);
```

The behavior is identical; the plan is dramatically better. Apply this to `auth.jwt()` and any other auth helper too. **Always index the column you're filtering on** — `author_id`, `org_id`, etc. RLS is just a `WHERE`, and `WHERE` without an index does a full scan.

## JWT custom claims (org_id, role, plan)

Don't query `org_members` in every policy if you can stuff the org list into the JWT. Set up a **custom access token hook** in `config.toml`:

```toml
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token_hook"
```

```sql
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
as $$
declare
  user_id uuid := (event ->> 'user_id')::uuid;
  claims jsonb := event -> 'claims';
  orgs jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', org_id, 'role', role))
    into orgs
    from public.org_members
    where user_id = custom_access_token_hook.user_id;

  claims := jsonb_set(claims, '{user_orgs}', coalesce(orgs, '[]'::jsonb));
  return jsonb_build_object('claims', claims);
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
```

Now read claims from `auth.jwt()` in policies — no join, no function call, just JSON access:

```sql
create policy "documents_select_via_jwt" on public.documents
  for select using (
    documents.org_id::text in (
      select jsonb_array_elements(auth.jwt() -> 'user_orgs') ->> 'id'
    )
  );
```

**Tradeoff:** JWTs are stale until the next refresh (default 1 hour). If you remove a user from an org, they keep access until their token rotates. For low-stakes apps this is fine. For "kick a user immediately" requirements, stick with the `org_members` join + helper function approach.

## The role you forget about: `service_role`

Three Supabase roles, they're not interchangeable:

| Role            | Where it's used                            | RLS applies?                   |
| --------------- | ------------------------------------------ | ------------------------------ |
| `anon`          | Unauthenticated client requests            | Yes                            |
| `authenticated` | Signed-in client requests                  | Yes                            |
| `service_role`  | Server scripts, edge functions, migrations | **No — bypasses RLS entirely** |

The service role key is shipped to your scripts, never to the client. **Never** ship it with `EXPO_PUBLIC_` — that's a database admin key on every user's phone. Keep it in `.env.local` for `scripts/` and in EAS secrets / edge function env for production.

When debugging "RLS works in Studio but fails from the app," it's because Studio uses `service_role` and your app uses `authenticated`. Test with the actual key:

```bash
curl 'http://127.0.0.1:54321/rest/v1/posts' \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $USER_JWT"  # paste a real user JWT
```

## Storage policies are separate

`storage.objects` has its own RLS. The `posts` table policies do not cover the avatar files in storage. See the `supabase-storage` skill — this is the most-missed corner of RLS.

## Debugging RLS

When a query returns `[]` and you swear it should return rows:

1. **Run the same query in Studio's SQL editor** — Studio uses `service_role`, so this confirms the data exists. If it's empty there too, the data isn't there.
2. **Check policies are present:** `select * from pg_policies where tablename = 'posts';`
3. **Test as a real user.** In Studio's SQL editor, set the role: `set role authenticated; set request.jwt.claim.sub = '<user-uuid>';` then re-run the query.
4. **Check the explain plan:** `explain analyze select * from posts;` — if you see `Filter:` clauses with `auth.uid()` per row, refactor to the `(select auth.uid())` pattern.
5. **Make sure you have a policy for every operation.** A common bug: SELECT policy exists, INSERT policy missing → `insert` returns success-shaped response with no row, query returns empty.

## Hard rules

- **Don't ship a public table without RLS.** Ever. Wire `scripts/check-rls.js` into CI.
- **Don't put the service_role key on the client.** Anywhere. Not in `.env`, not in EAS public config, not in tests that get committed.
- **Don't write `for all` policies** unless you've thought through every operation. Be explicit per-op.
- **Don't call `auth.uid()` directly in policies on big tables.** Wrap in `(select auth.uid())`.
- **Don't forget `with check` on UPDATE.** Without it, ownership transfers are possible.
- **Don't write SELECT policies that return all rows for `service_role`-feeling things.** RLS doesn't apply to the service role, but `authenticated` users hit those policies. A `using (true)` policy on a sensitive table is a leak.
- **Don't forget to index the columns RLS filters on.** `org_id`, `author_id`, `user_id` should all be indexed.
- **Don't write helper functions without `security definer` + `set search_path = public`.** Without them, they run as the caller and can re-enter RLS — infinite loop or permission denial.

## Quick checklist for a new table

```sql
-- 1. Create with the right ownership column(s)
create table public.posts (
  id uuid primary key default extensions.uuid_generate_v4(),
  author_id uuid not null references public.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade, -- if multi-tenant
  -- ... other columns
);

-- 2. Index every column an RLS policy will filter on
create index posts_author_id_idx on public.posts (author_id);
create index posts_org_id_idx    on public.posts (org_id);

-- 3. Enable RLS — non-negotiable
alter table public.posts enable row level security;

-- 4. One policy per operation, each using (select auth.uid())
create policy "posts_select_authed" on public.posts
  for select using ((select auth.uid()) is not null);
create policy "posts_insert_own" on public.posts
  for insert with check ((select auth.uid()) = author_id);
create policy "posts_update_own" on public.posts
  for update using ((select auth.uid()) = author_id)
              with check ((select auth.uid()) = author_id);
create policy "posts_delete_own" on public.posts
  for delete using ((select auth.uid()) = author_id);

-- 5. Test from an authenticated session, not Studio
```
