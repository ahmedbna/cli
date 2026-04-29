---
name: supabase-advanced-rls
description: Postgres Row Level Security policies — multi-tenant access, JWT claims, helper functions, performance tuning, and debugging silent empty results.
---

# Supabase Advanced RLS

The anon key ships to every client. **Every public table needs RLS.** RLS in Supabase _is_ your authorization layer. Failure mode is silent: queries return `[]`, no error.

## Mental model

A policy is a `WHERE` clause silently AND-ed into every query:
- `select` returns only rows where `USING` is true.
- `insert` succeeds only if the new row satisfies `WITH CHECK`.
- `update` requires `USING` (old row) AND `WITH CHECK` (new row).
- `delete` requires `USING`.

## Always enable RLS

```sql
alter table public.posts enable row level security;
```

## One policy per operation

```sql
alter table public.posts enable row level security;

-- Read: any authenticated user
create policy "posts_select_authed" on public.posts
  for select using (auth.uid() is not null);

-- Insert: must be the author
create policy "posts_insert_own" on public.posts
  for insert with check (auth.uid() = author_id);

-- Update: only own row, can't change author_id
create policy "posts_update_own" on public.posts
  for update
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

-- Delete: only own
create policy "posts_delete_own" on public.posts
  for delete using (auth.uid() = author_id);
```

`with check` on UPDATE prevents ownership transfers.

## Multi-tenant: organizations / teams

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

Pull join into a helper function (cached, bypasses RLS on lookup):

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

create policy "documents_select_member" on public.documents
  for select using (public.is_org_member(org_id));

create policy "documents_insert_member" on public.documents
  for insert with check (public.is_org_member(org_id));
```

Role check helper:

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

## Performance: wrap-in-select trick

`auth.uid()` runs **once per row** by default. Wrap in scalar subquery to evaluate once:

```sql
-- Slow: per-row
create policy "p_slow" on public.posts
  for select using (auth.uid() = author_id);

-- Fast: evaluated once
create policy "p_fast" on public.posts
  for select using ((select auth.uid()) = author_id);
```

**Always index columns that RLS filters on** — `author_id`, `org_id`, etc.

## JWT custom claims

Stuff org list into the JWT via custom access token hook:

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

Read claims directly:

```sql
create policy "documents_select_via_jwt" on public.documents
  for select using (
    documents.org_id::text in (
      select jsonb_array_elements(auth.jwt() -> 'user_orgs') ->> 'id'
    )
  );
```

**Tradeoff:** JWTs are stale until refresh (default 1 hour). For "kick immediately" requirements, use the join + helper approach.

## The three roles

| Role            | Used by                                    | RLS applies?                   |
| --------------- | ------------------------------------------ | ------------------------------ |
| `anon`          | Unauthenticated client requests            | Yes                            |
| `authenticated` | Signed-in client requests                  | Yes                            |
| `service_role`  | Server scripts, edge functions, migrations | **No — bypasses RLS entirely** |

**Never** ship the service role key with `EXPO_PUBLIC_`. Keep it in `.env.local` for `scripts/` and EAS secrets / edge function env in production.

When debugging "RLS works in Studio but fails from the app" — Studio uses `service_role`. Test with the actual key:

```bash
curl 'http://127.0.0.1:54321/rest/v1/posts' \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $USER_JWT"
```

## Storage policies are separate

`storage.objects` has its own RLS. Table policies do not cover storage files. See `supabase-storage`.

## Debugging RLS

When a query returns `[]`:

1. **Run in Studio's SQL editor** (uses `service_role`). If empty there, data isn't there.
2. **Check policies exist**: `select * from pg_policies where tablename = 'posts';`
3. **Test as a real user**: `set role authenticated; set request.jwt.claim.sub = '<user-uuid>';`
4. **Check explain plan**: `explain analyze select * from posts;` — refactor to `(select auth.uid())` if per-row.
5. **Make sure you have a policy for every operation.**

## Hard rules

- **Don't ship a public table without RLS.**
- **Don't put service_role on the client.**
- **Don't write `for all` policies** — be explicit per-op.
- **Don't call `auth.uid()` directly on big tables** — wrap in `(select auth.uid())`.
- **Don't forget `with check` on UPDATE** — ownership transfers possible.
- **Don't index-skip columns RLS filters on.**
- **Don't write helpers without `security definer` + `set search_path = public`.**

## New table checklist

```sql
-- 1. Create with ownership column(s)
create table public.posts (
  id uuid primary key default extensions.uuid_generate_v4(),
  author_id uuid not null references public.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
);

-- 2. Index every RLS-filtered column
create index posts_author_id_idx on public.posts (author_id);
create index posts_org_id_idx    on public.posts (org_id);

-- 3. Enable RLS
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
```
