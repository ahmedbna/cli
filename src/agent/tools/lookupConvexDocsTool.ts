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
    description: `Look up Convex docs for advanced features. Use before writing code for any of these topics:
- file-storage: upload/download, storage IDs, signed URLs
- full-text-search: search indexes, filter fields
- pagination: paginated queries, cursors, usePaginatedQuery
- http-actions: HTTP endpoints in convex/router.ts
- scheduling-cron: cron jobs (crons.interval / crons.cron only)
- scheduling-runtime: ctx.scheduler.runAfter
- actions-nodejs: "use node" files, external APIs, no ctx.db
- typescript-types: Doc<>, Id<>, Record types
- function-calling: ctx.runQuery / runMutation / runAction
- query-advanced: ordering, range queries, compound indexes
- mutation-advanced: batch ops, upsert, transactional updates`,
    parameters: lookupConvexDocsParameters,
  };
}

// Documentation content by topic
export const convexDocs = {
  'file-storage': `
# File Storage
- Store \`storageId\` (not URLs) in DB. Get URL on read: \`await ctx.storage.getUrl(storageId)\`
- Metadata via system table: \`await ctx.db.system.get(storageId)\`

\`\`\`ts
// Generate upload URL
export const generateUploadUrl = mutation({
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

// Save after upload
export const saveFile = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return ctx.db.insert("files", { userId, storageId });
  },
});

// List with URLs
export const getFiles = query({
  handler: async (ctx) => {
    const files = await ctx.db.query("files").collect();
    return Promise.all(files.map(async (f) => ({
      ...f, url: await ctx.storage.getUrl(f.storageId),
    })));
  },
});
\`\`\`

\`\`\`tsx
// React Native upload
const generateUploadUrl = useMutation(api.files.generateUploadUrl);
const saveFile = useMutation(api.files.saveFile);

const upload = async (uri: string) => {
  const postUrl = await generateUploadUrl();
  const blob = await (await fetch(uri)).blob();
  const { storageId } = await (await fetch(postUrl, {
    method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob,
  })).json();
  await saveFile({ storageId });
};
\`\`\`

Schema: \`storageId: v.id("_storage")\`
DO NOT use deprecated \`ctx.storage.getMetadata\`.
`,

  'full-text-search': `
# Full-Text Search

\`\`\`ts
// Schema
messages: defineTable({ body: v.string(), channel: v.string() })
  .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] })

// Query
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
- searchField must be \`v.string()\`
- filterFields enable fast equality filtering within results
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
// Client
const { results, status, loadMore } = usePaginatedQuery(
  api.messages.list, {}, { initialNumItems: 20 }
);
// status: "LoadingFirstPage" | "CanLoadMore" | "Exhausted"
// loadMore(n) loads next n items
\`\`\`
`,

  'http-actions': `
# HTTP Actions — use convex/router.ts (NOT convex/http.ts)

\`\`\`ts
// convex/router.ts
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

- req methods: \`.text()\`, \`.json()\`, \`.bytes()\`, \`.pathParams\`, \`.headers\`
- Timeout: 10 min | Response size: 20 MiB
`,

  'scheduling-cron': `
# Cron Jobs — convex/crons.ts

\`\`\`ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every 2 hours
crons.interval("cleanup", { hours: 2 }, internal.cleanup.run, {});

// Daily at midnight UTC
crons.cron("daily report", "0 0 * * *", internal.reports.daily, {});

export default crons;
\`\`\`

ONLY use \`crons.interval\` or \`crons.cron\`. Auth does NOT propagate — pass userId as arg.
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

export const send = internalMutation({
  args: { userId: v.id("users"), msg: v.string() },
  handler: async (ctx, { userId, msg }) => {
    await ctx.db.insert("notifications", { userId, msg, sentAt: Date.now() });
  },
});
\`\`\`

- Auth does NOT propagate to scheduled functions — pass userId explicitly
- Minimum interval: 10 seconds. Never schedule in tight loops.
`,

  'actions-nodejs': `
# Node.js Actions

\`\`\`ts
"use node"; // Must be first line

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const generate = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    // No ctx.db — use ctx.runQuery / ctx.runMutation
    const history = await ctx.runQuery(internal.messages.list, {});
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    await ctx.runMutation(internal.messages.save, { text: res.choices[0].message.content! });
    return res.choices[0].message.content;
  },
});
\`\`\`

- Files with \`"use node"\` → ONLY actions. Never queries or mutations.
- esbuild bundler errors = Node.js API leak into non-node file → isolate to action with "use node"
`,

  'typescript-types': `
# TypeScript Types

\`\`\`ts
import { Doc, Id } from "./_generated/dataModel";

type User = Doc<"users">;
type UserId = Id<"users">;

// Typed IDs in args
export const get = query({
  args: { id: v.id("users") },
  handler: async (ctx, { id }): Promise<User | null> => ctx.db.get(id),
});

// Record type
const map: Record<Id<"users">, string> = {};

// Discriminated union
v.union(
  v.object({ kind: v.literal("ok"), value: v.number() }),
  v.object({ kind: v.literal("err"), message: v.string() }),
)
\`\`\`
`,

  'function-calling': `
# Cross-Function Calling

\`\`\`ts
// From action (can call queries, mutations, other actions)
export const process = action({
  handler: async (ctx) => {
    const data = await ctx.runQuery(api.items.list, {});         // query
    await ctx.runMutation(internal.items.save, { data });        // mutation
    await ctx.runAction(internal.ai.analyze, { data });          // action
  },
});
\`\`\`

- Always use \`api\` or \`internal\` references — never pass functions directly
- Minimize round-trips: batch reads into a single query when possible
- Same-file calls: add explicit return type annotation to avoid TS circularity errors
`,

  'query-advanced': `
# Advanced Queries

\`\`\`ts
// Order + limit
const latest = await ctx.db.query("msgs").order("desc").take(10);
const one    = await ctx.db.query("msgs").order("desc").first();

// Range query
const recent = await ctx.db.query("msgs")
  .withIndex("by_time", q => q.gt("_creationTime", Date.now() - 3600_000))
  .collect();

// Compound index
// Schema: .index("by_channel_author", ["channelId", "authorId"])
const msgs = await ctx.db.query("msgs")
  .withIndex("by_channel_author", q => q.eq("channelId", cid).eq("authorId", uid))
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

// patch = partial update | replace = full overwrite (must include all fields)
\`\`\`
`,
};

export type ConvexDocTopic = keyof typeof convexDocs;
