---
name: convex-file-storage
description: Use when implementing file uploads, image storage, media handling, file downloads, generating files in actions, or accessing file metadata with Convex storage. Trigger on "upload", "file storage", "store image", "media upload", "download file", "storageId", "AI image generation", or any feature involving user-uploaded or generated files.
---

# Convex File Storage

**Core rule:** Store `storageId` (not URLs) in DB. Generate URL on read: `await ctx.storage.getUrl(storageId)`. URLs from `generateUploadUrl()` expire in 1 hour. Upload POST timeout is 2 minutes.

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

## React Native Upload

```tsx
import * as ImagePicker from 'expo-image-picker';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';

function UploadButton() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  const pickAndUpload = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (result.canceled) return;

    const asset = result.assets[0];
    const blob = await (await fetch(asset.uri)).blob();

    // Step 1: Get upload URL
    const uploadUrl = await generateUploadUrl();

    // Step 2: POST file, parse storageId from response
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    });
    const { storageId } = await uploadResponse.json();

    // Step 3: Save storageId to DB
    await saveFile({ storageId });
  };

  return <Button onPress={pickAndUpload} title='Upload' />;
}
```

## Storing Generated Files in Actions

For files fetched/generated server-side (e.g., AI-generated images from external APIs), use `ctx.storage.store(blob)` directly in an action:

```ts
// convex/images.ts
import { action, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';

export const generateAndStore = action({
  args: { prompt: v.string() },
  handler: async (ctx, args) => {
    // Generate or fetch the file (e.g., call DALL-E, get image URL)
    const imageUrl = 'https://...';
    const response = await fetch(imageUrl);
    const blob = await response.blob();

    // Store in Convex
    const storageId: Id<'_storage'> = await ctx.storage.store(blob);

    // Persist via internal mutation
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

**Default:** Return URLs from queries via `ctx.storage.getUrl(storageId)` (shown in `getFiles` above). Use these directly in `<img src>` or `<Image>`.

**For access control at serve-time** (or files >20MB stay with URLs — HTTP actions cap at 20MB):

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

- **Upload URL via `generateUploadUrl`**: no file size limit, but POST has 2-min timeout. Use this for large files.
- **HTTP action upload/serve**: capped at **20MB** request/response. Use only for small files or when you need custom CORS/auth at the HTTP layer.
- **Always validate `storageId` with `v.id("_storage")`** — never accept raw strings.
- **Auth-gate `generateUploadUrl`** — anyone with the URL can upload until it expires.
- **Don't store URLs in DB** — they expire. Store the `storageId` and resolve to URL on read.
