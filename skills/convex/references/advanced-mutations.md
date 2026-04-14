# Convex Advanced Mutations

## Batch insert

```ts
export const createMany = mutation({
  args: { items: v.array(v.object({ text: v.string() })) },
  handler: async (ctx, { items }) => {
    return Promise.all(items.map(i => ctx.db.insert("tasks", i)));
  },
});
```

## Upsert pattern

```ts
export const upsert = mutation({
  args: { userId: v.id("users"), bio: v.string() },
  handler: async (ctx, { userId, bio }) => {
    const existing = await ctx.db.query("profiles")
      .withIndex("by_user", q => q.eq("userId", userId))
      .unique();
    if (existing) return ctx.db.patch(existing._id, { bio });
    return ctx.db.insert("profiles", { userId, bio });
  },
});
```

## Patch vs Replace

```ts
// Patch: shallow merge — only updates specified fields
await ctx.db.patch(id, { name: "New Name" });

// Replace: full replacement — must provide ALL fields
await ctx.db.replace(id, { name: "New", email: "new@example.com", bio: "" });
```

## Cascade delete

```ts
export const deleteUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    // Delete related records first
    const todos = await ctx.db.query("todos")
      .withIndex("by_user", q => q.eq("userId", userId))
      .collect();
    await Promise.all(todos.map(t => ctx.db.delete(t._id)));

    // Then delete the user
    await ctx.db.delete(userId);
  },
});
```

## Rules

- Mutations write at most 8192 documents and 8 MiB per transaction
- Mutation timeout is 1 second
- Mutations are transactional — all writes succeed or all fail
- Use `ctx.db.patch` for partial updates, `ctx.db.replace` for full replacement
