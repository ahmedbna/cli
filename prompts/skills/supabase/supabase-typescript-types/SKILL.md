---
name: supabase-typescript-types
description: Use when generating, regenerating, or working with Supabase's auto-generated TypeScript types — the `Database` type, `Tables<>`, `TablesInsert<>`, `TablesUpdate<>`, RPC types, or anything in `supabase/types.ts`. Trigger on "supabase gen types", "Database type", "Tables<", "TablesInsert", "TablesUpdate", "Json type", "type assertion any", "type 'never'", "createClient<Database>", "type generation", "schema types", "regenerate types", or "TypeScript Supabase".
---

# Supabase TypeScript Types

`supabase gen types` is the difference between Supabase feeling like a typed Convex app and feeling like throwing JS at a black-box REST API. Done right, every `from('posts').select()` autocompletes columns, every `.insert()` enforces the right shape, and refactors propagate through the whole codebase. Done wrong, you end up casting to `any` everywhere and the type system is decorative.

## The single source of truth

```bash
# Local (against running supabase start)
npx supabase gen types typescript --local > supabase/types.ts

# Against a linked remote project
npx supabase gen types typescript --linked > supabase/types.ts

# By project ref
npx supabase gen types typescript --project-id <ref> > supabase/types.ts
```

The BNA template wraps this in `npm run db:types`. Run it **after every migration**. The output starts with:

```ts
export type Database = {
  public: {
    Tables: {
      posts: {
        Row: {
          /* … */
        };
        Insert: {
          /* … */
        };
        Update: {
          /* … */
        };
        Relationships: [
          /* … */
        ];
      };
      // …
    };
    Views: {
      /* … */
    };
    Functions: {
      /* … */
    };
    Enums: {
      /* … */
    };
    CompositeTypes: {
      /* … */
    };
  };
};
```

Three things matter: `Row` (what comes back from SELECT), `Insert` (what you can INSERT — required vs optional fields differ from Row because of defaults), and `Update` (everything optional, since UPDATE is partial).

## Wire it in once

The `createClient<Database>` generic is what propagates types through every `.from()` call:

```ts
// supabase/client.ts
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

export const supabase = createClient<Database>(url, anonKey, {
  /* … */
});
```

Without that generic, `supabase.from('posts').select()` returns `any[]` and you've thrown away every type the generator just produced. **Most "Supabase types don't work" issues come down to a missing generic on `createClient`.**

## Helper types you'll use everywhere

The raw `Database` type is verbose. Define type helpers once and use them everywhere:

```ts
// supabase/types.ts (append at the bottom; gen types preserves trailing content
// in newer CLI versions, but to be safe, put helpers in a separate file)

// supabase/db-types.ts
import type { Database } from './types';

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];

export type Enums<T extends keyof Database['public']['Enums']> =
  Database['public']['Enums'][T];
```

```ts
// Now in any module
import type { Tables, TablesInsert } from '@/supabase/db-types';

export type Post = Tables<'posts'>;
export type NewPost = TablesInsert<'posts'>;
```

These three (`Tables`, `TablesInsert`, `TablesUpdate`) are the workhorses. `Tables<'users'>` is what `select` returns; `TablesInsert<'users'>` is what `insert` accepts.

The latest CLI versions of `supabase gen types` actually generate these helpers automatically — check the bottom of `types.ts` and use the generated ones if present.

## The `select` projection — preserving types through queries

A bare `select('*')` returns `Row`. The moment you select a subset, `select('id, name')` returns `Pick<Row, 'id' | 'name'>` automatically — no type assertion needed:

```ts
const { data } = await supabase.from('posts').select('id, content');
// data: { id: string; content: string }[] | null
```

Joins also typecheck:

```ts
const { data } = await supabase
  .from('posts')
  .select('id, content, author:users(id, name)');
// data: { id: string; content: string; author: { id: string; name: string | null } }[] | null
```

The `author:users(...)` syntax follows the foreign key. If a relation is **one-to-many**, the joined field is an array; if it's **one-to-one** or **many-to-one** with a unique constraint, it's a single object.

When the generator can't infer (most often: ambiguous joins between two tables with multiple FKs), explicit hint syntax fixes it:

```ts
.select('*, author:users!posts_author_id_fkey(*)')
```

Use the FK constraint name from the migration. `supabase gen types` also exposes these as `Relationships` entries in the generated file.

## `.single()` and `.maybeSingle()` — narrowing

```ts
// returns single row OR throws if 0/2+ rows match
const { data, error } = await supabase
  .from('users')
  .select('*')
  .eq('id', id)
  .single();
// data: User | null, error: PostgrestError | null

// returns single row OR null if 0 rows; throws if 2+
const { data } = await supabase
  .from('users')
  .select('*')
  .eq('id', id)
  .maybeSingle();
// data: User | null
```

Use `maybeSingle()` for "find by id or return null" — the more common case. `single()` when you've verified upstream that the row must exist (e.g. by primary key right after insert).

Without `.single()` / `.maybeSingle()`, `data` is `User[] | null` and you're indexing `[0]` everywhere. Don't.

## RPC types

`supabase gen types` introspects functions too. The args and return type of every RPC propagate:

```ts
// Generated from `create function increment_post_likes(_post_id uuid) returns integer`
const { data, error } = await supabase.rpc('increment_post_likes', {
  _post_id: postId,
});
// data: number | null
```

If you add a new function, types don't update until you regen — `data` will be `unknown` until you run `npm run db:types`. This is the #1 reason "RPC types don't work."

For functions returning rows (`returns setof posts` or `returns table (...)`), the return is correctly typed as an array of the row shape:

```ts
// Returns table (post_count int, total_likes int)
const { data } = await supabase.rpc('get_user_stats', { _user_id: userId });
// data: Array<{ post_count: number; total_likes: number }> | null
```

## The `Json` type — usually wrong

Postgres `jsonb` columns generate as the `Json` type:

```ts
type Json =
  | string
  | number
  | boolean
  | null
  | { [k: string]: Json | undefined }
  | Json[];
```

Technically correct, practically useless. If you have a `metadata jsonb` column with a known shape, narrow it explicitly:

```ts
type PostMetadata = { editor: string; word_count: number; tags: string[] };

type Post = Omit<Tables<'posts'>, 'metadata'> & {
  metadata: PostMetadata | null;
};

// Or at the call site:
const { data } = await supabase.from('posts').select('*').eq('id', id).single();
const meta = data?.metadata as PostMetadata | null;
```

The cast is a runtime contract — postgres won't enforce it. Pair with a Zod schema if you care:

```ts
import { z } from 'zod';

const PostMetadata = z.object({
  editor: z.string(),
  word_count: z.number(),
  tags: z.array(z.string()),
});

const meta = PostMetadata.parse(data.metadata);
```

## The `never` type — the most confusing error

Symptom: `Type 'never' is not assignable to ...`, usually on `.update()` or `.insert()`. Cause: TypeScript thinks the table doesn't exist in `Database['public']['Tables']`.

Three usual reasons:

1. **Stale types.** You added the table but didn't regen. Run `npm run db:types`.
2. **Missing `<Database>` generic on `createClient`.** Without it, every from() loses its types and the SDK falls back to "table is `never`."
3. **Custom schema not included.** If your table is in a non-`public` schema (`api`, `app`, etc.), you must add it to the generation command:
   ```bash
   supabase gen types typescript --schema public --schema api > supabase/types.ts
   ```

## Insert vs Row — why they differ

```sql
create table posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  content text not null,
  like_count integer not null default 0,
  created_at timestamptz not null default now()
);
```

```ts
type Post = Tables<'posts'>;
// { id: string; author_id: string; content: string; like_count: number; created_at: string }

type NewPost = TablesInsert<'posts'>;
// { id?: string; author_id: string; content: string; like_count?: number; created_at?: string }
```

`Insert` makes columns with defaults _optional_. `Row` makes them required (you'll always read them). This is correct, but means you can't use `Post` as the type for an insert payload — use `TablesInsert<'posts'>`.

## Generated columns and views

`Generated columns` are read-only — they appear in `Row` but are absent from `Insert` and `Update` (correctly).

`Views` are typed under `Database['public']['Views']`. You can `from('view_name').select(...)` and get full types. Most views won't have working `Insert`/`Update` (they're not generally writable), so the generator omits those.

## Workflow: schema change → typed app

The loop should be tight:

```bash
# 1. Edit a migration file (or use db diff)
vim supabase/migrations/0009_add_comments.sql

# 2. Apply locally
npm run db:reset

# 3. Regenerate types
npm run db:types

# 4. Use them — TS errors point you at every call site that needs to update
```

The TS compiler becomes your refactor tool. Add a column, regen, fix the errors. Remove a column, regen, find every dead reference. This is the whole pitch of code-first Supabase.

## Running types in CI

To prevent "merged a migration but forgot to regenerate types" PRs, add a check:

```bash
# scripts/check-types.sh
supabase gen types typescript --local > /tmp/expected-types.ts
if ! diff -q supabase/types.ts /tmp/expected-types.ts; then
  echo "supabase/types.ts is out of date. Run npm run db:types."
  exit 1
fi
```

Wire into CI alongside `db:check-rls`.

## Hard rules

- **Don't skip the `<Database>` generic on `createClient`.** All other typing depends on it.
- **Don't hand-edit `supabase/types.ts`.** It's regenerated; your edits get nuked. Helper types go in a separate file.
- **Don't cast to `any` to make the error go away.** Almost always the right fix is regenerating types.
- **Don't trust the `Json` type.** Cast or validate to a real shape.
- **Don't use `Row` types for inserts.** Use `TablesInsert<'name'>`.
- **Don't forget `--schema` flags for non-public schemas.**
- **Don't commit a PR without regenerating types** if you touched migrations.
- **Don't index `[0]` on a single-row query.** Use `.single()` or `.maybeSingle()`.
- **Don't write `as Post` when you mean to query.** If TS types are wrong, fix the type, don't override it.

## Quick checklist for type setup

1. **`createClient<Database>(...)`** in `supabase/client.ts`.
2. **`npm run db:types` after every migration.** Make it muscle memory.
3. **Helper types** (`Tables`, `TablesInsert`, `TablesUpdate`) in `supabase/db-types.ts` — use the auto-generated ones if your CLI emits them.
4. **`.single()` / `.maybeSingle()` for one-row reads.**
5. **Narrow `Json` columns** with explicit types or Zod.
6. **CI check** that `types.ts` matches the live schema.
7. **Non-public schemas: pass `--schema` flag.**
