---
name: supabase-storage
description: Use when uploading, downloading, or managing files in Supabase Storage from an Expo app — avatars, photos, documents, signed URLs, public buckets, image transforms, or storage RLS policies. Trigger on "supabase.storage", "upload file", "avatar upload", "image picker", "createSignedUrl", "from('avatars')", "bucket policy", "storage.objects", "storage.buckets", "presigned URL", "expo-image-picker", "FormData", or any file-handling that goes through Supabase Storage.
---

# Supabase Storage from Expo

Supabase Storage is S3-compatible blob storage with its own RLS layer separate from your tables. Two things people always miss: **storage has its own policies** (`storage.objects`, not your `users` policies), and **React Native uploads need a special URI-based form** because there is no `File` constructor.

## Buckets — created in migrations, not the dashboard

Code-first means buckets live in SQL, not Studio. Add them as a migration so every dev / staging / prod gets them automatically:

```sql
-- supabase/migrations/0005_storage_buckets.sql

-- Avatars: public read (so <Image source={{uri}} /> works without signing)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,                                  -- public bucket
  2 * 1024 * 1024,                       -- 2 MB cap
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Documents: private, requires signed URL or auth header to read
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  10 * 1024 * 1024,                      -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;
```

`public: true` doesn't mean anyone can write — it means _reads_ don't require an auth header. Writes are still gated by RLS on `storage.objects`.

## Storage RLS — the part everyone forgets

`storage.objects` is just a table. RLS rules apply to it, separately from your tables. Without policies, even the bucket owner can't upload from the client. Path conventions are the trick: store files at `{user_id}/{filename}` so policies can match the user via the path.

```sql
-- supabase/migrations/0006_storage_policies.sql

-- AVATARS: anyone can read (public bucket = no policy needed for read,
-- but a policy is needed if you want anon to read with auth header).
-- Owners can write to their own folder only.

create policy "avatar_insert_own_folder"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "avatar_update_own"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "avatar_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- DOCUMENTS: private bucket. Only the owner can read OR write.
create policy "documents_select_own"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "documents_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
```

`storage.foldername(name)` parses `42/avatar.png` into `{42, avatar.png}` and `[1]` grabs the first segment. Always store files as `{auth.uid()}/{filename}` and policies stay one-liners.

For team/org files, use `{org_id}/{filename}` and reuse the `is_org_member()` helper from the advanced-rls skill:

```sql
create policy "team_files_member_read"
  on storage.objects for select
  using (
    bucket_id = 'team_files'
    and public.is_org_member((storage.foldername(name))[1]::uuid)
  );
```

## Uploading from Expo — the React Native gotcha

`supabase.storage.from('x').upload(path, file)` expects a `File` or `Blob`. **Neither exists in React Native.** You have a URI from `expo-image-picker` and a string mime type.

The working pattern: pass a `FormData`-style object Supabase recognizes, OR convert the URI to an `ArrayBuffer` first. The ArrayBuffer route is more reliable — `FormData` shapes change between Expo versions.

```ts
// supabase/api/avatars.ts
import { supabase } from '@/supabase/client';
import { ApiError, requireUserId } from './_helpers';
import * as FileSystem from 'expo-file-system';
import { decode } from 'base64-arraybuffer';

export const avatars = {
  async upload(uri: string, mimeType: string) {
    const userId = await requireUserId();

    // Read the file from disk as base64, then decode to ArrayBuffer.
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const arrayBuffer = decode(base64);

    const ext = mimeType.split('/')[1] ?? 'jpg';
    const path = `${userId}/avatar-${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from('avatars')
      .upload(path, arrayBuffer, {
        contentType: mimeType,
        upsert: true,
      });
    if (error) throw new ApiError(error.message, error.code, error);

    // Public bucket → grab the public URL and save it on the user row.
    const {
      data: { publicUrl },
    } = supabase.storage.from('avatars').getPublicUrl(data.path);

    await supabase.from('users').update({ image: publicUrl }).eq('id', userId);
    return publicUrl;
  },
};
```

Install: `npx expo install expo-file-system base64-arraybuffer`.

The `upsert: true` flag lets the user replace an existing avatar at the same path. Without it, re-upload throws `Duplicate`. Pair it with a deterministic path (`avatar.jpg` instead of `avatar-${Date.now()}.jpg`) if you don't want a graveyard of old files.

For the picker:

```ts
import * as ImagePicker from 'expo-image-picker';

async function pickAvatar() {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });
  if (result.canceled) return;
  const asset = result.assets[0];
  await api.avatars.upload(asset.uri, asset.mimeType ?? 'image/jpeg');
}
```

## Reading files

### Public bucket — direct URL

```ts
const {
  data: { publicUrl },
} = supabase.storage.from('avatars').getPublicUrl(`${userId}/avatar.jpg`);

// <Image source={{ uri: publicUrl }} />
```

`getPublicUrl` is synchronous and doesn't check the file exists. It just builds a URL. If the file is gone, the `<Image>` will show its error fallback.

### Private bucket — signed URL

```ts
async function getDocumentUrl(path: string) {
  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(path, 60 * 60); // 1 hour
  if (error) throw new ApiError(error.message, error.code, error);
  return data.signedUrl;
}
```

Signed URLs are time-limited bearer tokens — anyone with the URL can access the file until it expires. Don't log them, don't put them in URL params that get bookmarked, don't make the expiry weeks long.

For batch fetching:

```ts
const { data } = await supabase.storage
  .from('documents')
  .createSignedUrls(['user-123/doc1.pdf', 'user-123/doc2.pdf'], 60);
// data: [{ path, signedUrl, error }, ...]
```

### Image transforms (resize, format conversion)

Both public and signed URLs support transforms. Use them for thumbnails — don't render the full 4 MB original in a 60×60 avatar slot.

```ts
const {
  data: { publicUrl },
} = supabase.storage.from('avatars').getPublicUrl(path, {
  transform: { width: 200, height: 200, resize: 'cover', quality: 80 },
});
```

Available on private buckets too:

```ts
await supabase.storage.from('photos').createSignedUrl(path, 3600, {
  transform: { width: 600, quality: 75 },
});
```

Transforms are billed separately on Supabase (free local). At scale, prefer pre-generating thumbnail sizes on upload (via a database trigger calling an edge function) rather than transforming on every read.

## Listing & deleting

```ts
// List a folder
const { data, error } = await supabase.storage
  .from('avatars')
  .list(`${userId}/`, {
    limit: 100,
    sortBy: { column: 'created_at', order: 'desc' },
  });

// Delete files (array of paths)
await supabase.storage.from('avatars').remove([`${userId}/old-avatar.jpg`]);
```

The list API is paginated. Always pass `limit` — the default of 100 silently caps results. For large folders, use `offset` to page.

## Cleanup on delete

If a user deletes their account, the `auth.users` row cascades to `public.users`, but **storage files are not cascaded**. They stick around until you remove them explicitly. Add a trigger:

```sql
create or replace function public.delete_user_storage()
returns trigger language plpgsql security definer set search_path = public, storage as $$
begin
  delete from storage.objects
   where bucket_id in ('avatars', 'documents')
     and (storage.foldername(name))[1] = old.id::text;
  return old;
end;
$$;

create trigger on_user_delete_cleanup
  before delete on public.users
  for each row execute function public.delete_user_storage();
```

## Hard rules

- **Don't** create buckets in the dashboard. Code-first means SQL migrations.
- **Don't** forget `storage.objects` policies. The bucket being "public" only affects reads. Writes still need RLS.
- **Don't** pass a `File` or `Blob` from RN — they don't exist. Use `expo-file-system` + `base64-arraybuffer` to make an `ArrayBuffer`.
- **Don't** rely on `getPublicUrl()` to validate existence. It just builds a string.
- **Don't** mint signed URLs with multi-day expiry "to be safe." A leaked 7-day URL is a 7-day breach.
- **Don't** render full-resolution images in tiny views. Use the `transform` option.
- **Don't** assume cascade-delete cleans up files. Add the trigger.
- **Don't** put untrusted user content under a path the user controls without sanitizing. Path traversal (`../../other-user/x`) is theoretically possible if you concatenate raw input into a path. Always prefix with `${auth.uid()}/`.
- **Don't** allow MIME types you don't need. Set `allowed_mime_types` on the bucket.

## Quick checklist for a new bucket

1. Migration: `insert into storage.buckets ...` with `public`, `file_size_limit`, `allowed_mime_types` set.
2. Migration: `create policy ...` for INSERT/UPDATE/DELETE on `storage.objects`, scoped via `(storage.foldername(name))[1]`.
3. Always store as `${auth.uid()}/{filename}` (or `${org_id}/{filename}` for shared).
4. Use `arrayBuffer` (not `File`) for uploads from RN.
5. Use `transform` to avoid loading full-res images for thumbnails.
6. Add a delete trigger so files are cleaned up when their owner row is deleted.
