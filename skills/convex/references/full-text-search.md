# Convex Full-Text Search

## Define a search index

```ts
// convex/schema.ts
messages: defineTable({
  body: v.string(),
  channel: v.string(),
  userId: v.id("users"),
})
  .index("by_channel", ["channel"])
  .searchIndex("search_body", {
    searchField: "body",
    filterFields: ["channel"],
  })
```

## Query with search

```ts
export const search = query({
  args: { q: v.string(), channel: v.optional(v.string()) },
  handler: async (ctx, { q, channel }) => {
    return ctx.db.query("messages")
      .withSearchIndex("search_body", (s) =>
        channel
          ? s.search("body", q).eq("channel", channel)
          : s.search("body", q)
      )
      .take(10);
  },
});
```

## Rules

- `searchField` must be a `v.string()` field
- `filterFields` are optional equality filters applied alongside the search
- Search queries return results ordered by relevance (not by creation time)
- Use `.take(n)` to limit results — `.collect()` also works but returns all matches
- Each table can have multiple search indexes
- Search indexes cannot be used with `.order()`
