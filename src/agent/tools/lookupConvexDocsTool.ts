import { z } from 'zod';

export const lookupConvexDocsParameters = z.object({
  topics: z
    .array(
      z.enum([
        'file-storage',
        'full-text-search',
        'pagination',
        'http-actions',
        'scheduling-cron',
        'scheduling-runtime',
        'actions-nodejs',
        'typescript-types',
        'function-calling',
        'query-advanced',
        'mutation-advanced',
      ]),
    )
    .describe(
      'Advanced Convex topics to look up before implementing features beyond basic CRUD.',
    ),
});

export function lookupConvexDocsTool() {
  return {
    description: `Look up Convex docs for advanced features.`,
    parameters: lookupConvexDocsParameters,
  };
}

export const convexDocs = {
  'file-storage': `
# File Storage
- Store \`storageId\` (not URLs) in DB. Get URL on read: \`await ctx.storage.getUrl(storageId)\`

\`\`\`ts
export const generateUploadUrl = mutation({
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const saveFile = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return ctx.db.insert("files", { userId, storageId });
  },
});

export const getFiles = query({
  handler: async (ctx) => {
    const files = await ctx.db.query("files").collect();
    return Promise.all(files.map(async (f) => ({
      ...f, url: await ctx.storage.getUrl(f.storageId),
    })));
  },
});
\`\`\`

Schema: \`storageId: v.id("_storage")\`
`,

  'full-text-search': `
# Full-Text Search

\`\`\`ts
messages: defineTable({ body: v.string(), channel: v.string() })
  .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] })

export const search = query({
  args: { q: v.string(), channel: v.optional(v.string()) },
  handler: async (ctx, { q, channel }) => {
    return ctx.db.query("messages")
      .withSearchIndex("search_body", (s) =>
        channel ? s.search("body", q).eq("channel", channel) : s.search("body", q)
      ).take(10);
  },
});
\`\`\`
`,

  pagination: `
# Pagination

\`\`\`ts
import { paginationOptsValidator } from "convex/server";

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) =>
    ctx.db.query("messages").order("desc").paginate(paginationOpts),
});
\`\`\`

\`\`\`tsx
const { results, status, loadMore } = usePaginatedQuery(
  api.messages.list, {}, { initialNumItems: 20 }
);
\`\`\`
`,

  'http-actions': `
# HTTP Actions — use convex/router.ts (NOT convex/http.ts)

\`\`\`ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/api/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const data = await req.json();
    await ctx.runMutation(internal.messages.create, { body: data.text });
    return Response.json({ ok: true });
  }),
});

export default http;
\`\`\`
`,

  'scheduling-cron': `
# Cron Jobs — convex/crons.ts

\`\`\`ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("cleanup", { hours: 2 }, internal.cleanup.run, {});
crons.cron("daily report", "0 0 * * *", internal.reports.daily, {});
export default crons;
\`\`\`
`,

  'scheduling-runtime': `
# Runtime Scheduling

\`\`\`ts
export const scheduleReminder = mutation({
  args: { userId: v.id("users"), msg: v.string(), delayMs: v.number() },
  handler: async (ctx, { userId, msg, delayMs }) => {
    await ctx.scheduler.runAfter(delayMs, internal.reminders.send, { userId, msg });
  },
});
\`\`\`
`,

  'actions-nodejs': `
# Node.js Actions

\`\`\`ts
"use node"; // Must be first line

import { action } from "./_generated/server";
import { internal } from "./_generated/api";

export const generate = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    // No ctx.db — use ctx.runQuery / ctx.runMutation
    const history = await ctx.runQuery(internal.messages.list, {});
    // ... external API call ...
    await ctx.runMutation(internal.messages.save, { text: "result" });
  },
});
\`\`\`
`,

  'typescript-types': `
# TypeScript Types

\`\`\`ts
import { Doc, Id } from "./_generated/dataModel";

type User = Doc<"users">;
type UserId = Id<"users">;

export const get = query({
  args: { id: v.id("users") },
  handler: async (ctx, { id }): Promise<User | null> => ctx.db.get(id),
});
\`\`\`
`,

  'function-calling': `
# Cross-Function Calling

\`\`\`ts
export const process = action({
  handler: async (ctx) => {
    const data = await ctx.runQuery(api.items.list, {});
    await ctx.runMutation(internal.items.save, { data });
    await ctx.runAction(internal.ai.analyze, { data });
  },
});
\`\`\`
`,

  'query-advanced': `
# Advanced Queries

\`\`\`ts
const latest = await ctx.db.query("msgs").order("desc").take(10);
const recent = await ctx.db.query("msgs")
  .withIndex("by_time", q => q.gt("_creationTime", Date.now() - 3600_000))
  .collect();
\`\`\`

NEVER use \`.filter()\` — always define and use indexes.
`,

  'mutation-advanced': `
# Advanced Mutations

\`\`\`ts
// Batch insert
export const createMany = mutation({
  args: { items: v.array(v.object({ text: v.string() })) },
  handler: async (ctx, { items }) => {
    return Promise.all(items.map(i => ctx.db.insert("tasks", i)));
  },
});

// Upsert
export const upsert = mutation({
  args: { userId: v.id("users"), bio: v.string() },
  handler: async (ctx, { userId, bio }) => {
    const existing = await ctx.db.query("profiles")
      .withIndex("by_user", q => q.eq("userId", userId)).unique();
    if (existing) return ctx.db.patch(existing._id, { bio });
    return ctx.db.insert("profiles", { userId, bio });
  },
});
\`\`\`
`,
};

export type ConvexDocTopic = keyof typeof convexDocs;
