## Convex Guidelines

Convex = database + realtime + functions + auth + storage. Realtime is automatic.
Call `lookupDocs` before writing code for: file storage, full-text search, pagination, HTTP actions, scheduling, crons.

## Functions

```ts
import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
export const fn = query({ args: { x: v.string() }, handler: async (ctx, args) => { /* ... */ } });
```

- Public: `query`, `mutation`, `action` | Internal: prefix with `internal`
- ALWAYS include arg validators. NEVER use return validators.
- Actions: add `"use node";` for Node built-ins. NEVER use `ctx.db` in actions.
- Env vars: `process.env.MY_KEY` works everywhere.
- Cross-context calls: `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`
- Public refs: `api` | Internal refs: `internal`

## Validators

`v.string()`, `v.number()`, `v.boolean()`, `v.id(table)`, `v.null()`, `v.array(v)`,
`v.object({...})`, `v.optional(v)`, `v.union(v1, v2)`
NEVER use `v.map()` or `v.set()`

## Schema

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
export default defineSchema({
  ...authTables, // NEVER remove
  users: defineTable({
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    image: v.optional(v.union(v.string(), v.null())),
    isAnonymous: v.optional(v.boolean()),
    // add fields here
  }).index('email', ['email']),
  // add tables here
});
```

### Index rules

- NEVER add `.index("by_creation_time", ["_creationTime"])` — automatic
- NEVER end custom index with `_creationTime`
- Name indexes to reflect fields: `["field1","field2"]` → `"by_field1_and_field2"`
- System provides `"by_id"` and `"by_creation_time"` automatically

## DB Operations

```ts
// Read
const doc = await ctx.db.get(id);
const results = await ctx.db.query("table").withIndex("by_x", q => q.eq("x", val)).order("desc").take(10);
// Write
await ctx.db.insert("table", { field: "val" });
await ctx.db.patch(id, { field: "new" });   // shallow merge
await ctx.db.replace(id, { field: "full" }); // full replace
await ctx.db.delete(id);
```

NEVER use `.filter()` — always use `.withIndex()`.
`.unique()` → single doc | `.collect()` / `.take(n)` → execute query.

## Auth

```ts
import { getAuthUserId } from "@convex-dev/auth/server";
const userId = await getAuthUserId(ctx);
if (!userId) return null; // or throw
```

Frontend: `const user = useQuery(api.auth.loggedInUser);`

## React Hooks

```tsx
import { useQuery, useMutation, useAction } from "convex/react";
const data = useQuery(api.mod.fn);            // undefined while loading
const mut  = useMutation(api.mod.fn);
const act  = useAction(api.mod.fn);
const item = useQuery(api.mod.get, id ? { id } : "skip"); // conditional — use "skip"
if (data === undefined) return <Spinner />;
```

## Limits

| | Limit |
|---|---|
| Args/return | 8 MiB |
| Document | 1 MiB |
| Array length | 8192 |
| Query/mutation read | 8 MiB / 16384 docs |
| Mutation write | 8 MiB / 8192 docs |
| Query/mutation timeout | 1s |
| Action timeout | 10 min |

## Directory Structure (backend)

```
convex/
├── schema.ts                # Add tables; keep ...authTables + users
├── auth.ts                  # Already exists — do not modify
├── auth.config.ts           # Already exists — NEVER modify
├── users.ts                 # Already exists
└── http.ts                  # Already exists
```

## Schema Pattern — ADD tables, keep existing ones

```ts
// convex/schema.ts
import { defineSchema, defineTable } from 'convex/server';
import { authTables } from '@convex-dev/auth/server';
import { v } from 'convex/values';
export default defineSchema({
  ...authTables, // NEVER remove
  users: defineTable({ /* keep existing fields */ }),
  myTable: defineTable({ userId: v.id('users'), text: v.string() }).index('by_user', ['userId']),
});
```

## Existing API

- `api.auth.loggedInUser` — current user or null
- `api.users.get` — current user (throws if not authed)
- `api.users.getAll` — all users except current
- `api.users.update({ name?, bio?, gender?, birthday? })`

## Locked files — NEVER modify

- `convex/auth.config.ts`

## Prohibited (backend)

- Modifying locked files (`convex/auth.config.ts`)
- Running `npx convex dev` / `npx convex deploy` — these are automatic
- Using `.filter()` in queries — always use `.withIndex()`
- Using `v.map()` or `v.set()` validators
- Using return validators
- Using `ctx.db` inside actions
