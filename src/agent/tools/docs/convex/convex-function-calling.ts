export const convexFunctionCallingDocs = `
# Convex Cross-Function Calling

## From actions — call queries, mutations, other actions
\`\`\`ts
export const process = action({
  handler: async (ctx) => {
    // Read data via query
    const data = await ctx.runQuery(api.items.list, {});

    // Write data via mutation
    await ctx.runMutation(internal.items.save, { data });

    // Call another action
    await ctx.runAction(internal.ai.analyze, { data });
  },
});
\`\`\`

## From mutations — call queries
\`\`\`ts
export const processOrder = mutation({
  handler: async (ctx) => {
    // Mutations can run queries (same transaction)
    const user = await ctx.runQuery(internal.users.getCurrent, {});

    // Mutations can schedule other functions
    await ctx.scheduler.runAfter(0, internal.notifications.send, {
      userId: user._id,
    });
  },
});
\`\`\`

## Reference types
- \`api.module.fn\` — public function references (exported from convex/ files)
- \`internal.module.fn\` — internal function references (not callable from client)

## Rules
- Queries cannot call mutations or actions
- Mutations can call queries (same transaction) and schedule functions
- Actions can call queries, mutations, and other actions
- Use \`internal\` for functions that should not be callable from the client
- Action-to-mutation calls are NOT in the same transaction
`;
