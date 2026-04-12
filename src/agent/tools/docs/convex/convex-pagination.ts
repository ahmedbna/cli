export const convexPaginationDocs = `
# Convex Pagination

## Backend — paginated query
\`\`\`ts
import { paginationOptsValidator } from "convex/server";

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) =>
    ctx.db.query("messages").order("desc").paginate(paginationOpts),
});
\`\`\`

## Frontend — usePaginatedQuery
\`\`\`tsx
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

function MessageList() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    {},
    { initialNumItems: 20 }
  );

  return (
    <FlatList
      data={results}
      renderItem={({ item }) => <MessageRow message={item} />}
      onEndReached={() => {
        if (status === "CanLoadMore") loadMore(20);
      }}
      onEndReachedThreshold={0.5}
      ListFooterComponent={
        status === "LoadingMore" ? <Spinner /> : null
      }
    />
  );
}
\`\`\`

## Rules
- \`.paginate()\` replaces \`.collect()\` or \`.take()\` — don't chain them
- \`status\` is one of: \`"LoadingFirstPage"\`, \`"CanLoadMore"\`, \`"LoadingMore"\`, \`"Exhausted"\`
- You can use \`.withIndex()\` and \`.order()\` before \`.paginate()\`
- The \`paginationOpts\` validator handles cursor management automatically
- \`initialNumItems\` sets how many items to load on first render
`;
