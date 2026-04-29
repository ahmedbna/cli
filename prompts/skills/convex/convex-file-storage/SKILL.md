---
name: convex-file-storage
description: Implement file uploads, image storage, and downloads with Convex storage — store `storageId` in DB and resolve URLs on read.
---

# Convex File Storage

**Core rule:** Store `storageId` in DB (not URLs). Generate URL on read: `await ctx.storage.getUrl(storageId)`. Upload URLs from `generateUploadUrl()` expire in 1 hour. Upload POST timeout is 2 minutes.

## Client Upload Flow (3 steps)

1. Client calls mutation → gets short-lived upload URL
2. Client POSTs file to that URL → receives `{ storageId }`
3. Client calls another mutation to save `storageId` to DB

```ts
// convex/files.ts
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    // Add auth check here to control who can upload
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveFile = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error('Not authenticated');
    return ctx.db.insert('files', { userId, storageId });
  },
});

export const getFiles = query({
  handler: async (ctx) => {
    const files = await ctx.db.query('files').collect();
    return Promise.all(
      files.map(async (f) => ({
        ...f,
        url: await ctx.storage.getUrl(f.storageId),
      })),
    );
  },
});
```

## Schema

```ts
files: defineTable({
  userId: v.id('users'),
  storageId: v.id('_storage'),
}).index('by_user', ['userId']);
```

## Storing Generated Files in Actions

For files fetched/generated server-side (e.g. AI-generated images), use `ctx.storage.store(blob)` directly:

```ts
import { action, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';

export const generateAndStore = action({
  args: { prompt: v.string() },
  handler: async (ctx, args) => {
    const imageUrl = 'https://...';
    const response = await fetch(imageUrl);
    const blob = await response.blob();

    const storageId: Id<'_storage'> = await ctx.storage.store(blob);

    await ctx.runMutation(internal.images.storeResult, {
      storageId,
      prompt: args.prompt,
    });
  },
});

export const storeResult = internalMutation({
  args: { storageId: v.id('_storage'), prompt: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert('images', args);
  },
});
```

## Serving Files

**Default:** Return URLs from queries via `ctx.storage.getUrl(storageId)`. Use directly in `<Image source={url} />`.

**For access control or custom HTTP serving** (HTTP actions cap at 20MB):

```ts
// convex/http.ts
http.route({
  path: '/getImage',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const storageId = new URL(request.url).searchParams.get(
      'storageId',
    ) as Id<'_storage'>;
    const blob = await ctx.storage.get(storageId);
    if (!blob) return new Response('Not found', { status: 404 });
    return new Response(blob);
  }),
});
```

## Deleting Files

Always delete the underlying storage when removing the DB record — orphaned blobs are not auto-cleaned.

```ts
export const deleteFile = mutation({
  args: { fileId: v.id('files') },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (!file) return;
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(fileId);
  },
});
```

## File Metadata

Query the `_storage` system table for `size`, `contentType`, `sha256`:

```ts
export const getMetadata = query({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    return await ctx.db.system.get(storageId);
    // Returns: { _id, _creationTime, contentType, sha256, size }
  },
});
```

## Limits & Gotchas

- **`generateUploadUrl`**: no file size limit, but POST has 2-min timeout. Use for large files.
- **HTTP action upload/serve**: capped at **20MB**.
- **Always validate `storageId` with `v.id("_storage")`** — never accept raw strings.
- **Auth-gate `generateUploadUrl`** — anyone with the URL can upload until it expires.
- **Don't store URLs in DB** — they expire. Store `storageId`.
