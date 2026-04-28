---
name: expo-image-media
description: Use when implementing image display, image picking, camera capture, image manipulation, or media library access in React Native/Expo. Trigger on "image", "photo", "gallery", "image picker", "expo-image", "media", "blurhash", "thumbhash", "crop", "resize", "save to camera roll", uploading images to convex or supabase storage or displaying/uploading user photos.
---

# Expo Image & Media

Four packages cover the full image lifecycle: **expo-image** (display), **expo-image-picker** (capture/select), **expo-image-manipulator** (transform), **expo-media-library** (save/query device media).

## expo-image — Display

Performant cross-platform image with caching, blurhash/thumbhash placeholders, and transitions. Always prefer over RN `Image`.

```tsx
import { Image } from 'expo-image';

const blurhash = 'LEHV6nWB2yk8pyoJadR*.7kCMdnj';

<Image
  source='https://example.com/photo.jpg'
  style={{ width: 200, height: 200, borderRadius: 12 }}
  contentFit='cover' // 'cover' | 'contain' | 'fill' | 'none' | 'scale-down'
  placeholder={{ blurhash }} // or { thumbhash } or a local require()
  placeholderContentFit='cover' // match contentFit to avoid flicker
  transition={300} // ms cross-dissolve
  cachePolicy='memory-disk' // 'none' | 'disk' | 'memory' | 'memory-disk'
  priority='normal' // 'low' | 'normal' | 'high'
  recyclingKey={item.id} // use in FlatList/FlashList to avoid stale frames
/>;
```

**Static methods** (call on `Image`):

- `Image.prefetch(urls, { cachePolicy: 'memory-disk' })` — preload before display
- `Image.clearMemoryCache()` / `Image.clearDiskCache()`
- `Image.generateBlurhashAsync(uri, [4, 3])` — generate hash on device

**SF Symbols on iOS** (use `sf:` prefix): `<Image source="sf:star.fill" tintColor="#facc15" />`

## expo-image-picker — Pick / Capture

```bash
npx expo install expo-image-picker
```

```tsx
import * as ImagePicker from 'expo-image-picker';

// Hook for permissions (preferred)
const [status, requestPermission] = ImagePicker.useMediaLibraryPermissions();

const pickImage = async () => {
  // Request before launching to avoid post-pick permission dialogs on iOS
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], // array form; or ["images", "videos"]
    allowsEditing: true,
    aspect: [1, 1], // Android only; iOS crop is always square
    quality: 0.8, // 0..1
    allowsMultipleSelection: false, // set true + selectionLimit for multi
  });

  if (!result.canceled) {
    const asset = result.assets[0];
    // asset.uri, asset.width, asset.height, asset.fileSize, asset.mimeType
  }
};

const takePhoto = async () => {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return;
  const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
  if (!result.canceled) {
    /* result.assets[0].uri */
  }
};
```

**Note:** `MediaTypeOptions` is deprecated — use the string array form `["images"]`, `["videos"]`, `["livePhotos"]` (iOS).

## expo-image-manipulator — Transform

```bash
npx expo install expo-image-manipulator
```

Use the chainable context API (the older `manipulateAsync` is deprecated):

```tsx
import {
  useImageManipulator,
  FlipType,
  SaveFormat,
} from 'expo-image-manipulator';

const context = useImageManipulator(uri);

const transform = async () => {
  context
    .resize({ width: 800 }) // height auto from aspect ratio
    .rotate(90)
    .flip(FlipType.Vertical)
    .crop({ originX: 0, originY: 0, width: 400, height: 400 });

  const image = await context.renderAsync();
  const result = await image.saveAsync({
    format: SaveFormat.JPEG, // JPEG | PNG | WEBP
    compress: 0.8,
    base64: false,
  });
  // result.uri, result.width, result.height
};
```

## expo-media-library — Save / Query

```bash
npx expo install expo-media-library
```

```tsx
import * as MediaLibrary from 'expo-media-library';

const [perm, requestPerm] = MediaLibrary.usePermissions();

// Quick save (no asset returned)
await MediaLibrary.saveToLibraryAsync(localUri);

// Save and get asset back, optionally into an album
const asset = await MediaLibrary.createAssetAsync(localUri);
const album = await MediaLibrary.getAlbumAsync('MyApp');
if (album) await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
else await MediaLibrary.createAlbumAsync('MyApp', asset, false);
```

## app.json — Permissions Plugin Config

```json
{
  "expo": {
    "plugins": [
      [
        "expo-image-picker",
        {
          "photosPermission": "Allow $(PRODUCT_NAME) to access your photos.",
          "cameraPermission": "Allow $(PRODUCT_NAME) to use your camera.",
          "microphonePermission": false
        }
      ],
      [
        "expo-media-library",
        {
          "photosPermission": "Allow $(PRODUCT_NAME) to access your photos.",
          "savePhotosPermission": "Allow $(PRODUCT_NAME) to save photos.",
          "isAccessMediaLocationEnabled": true
        }
      ]
    ]
  }
}
```

## Upload to Convex Storage

Three steps: (1) call a mutation that returns an upload URL, (2) `POST` the file bytes to it and read back the `storageId`, (3) call your own mutation to persist that `storageId` on a row.

**Convex side** — define both mutations yourself:

```ts
// convex/files.ts
import { mutation } from './_generated/server';
import { v } from 'convex/values';

export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

// Persist the storageId however your schema expects.
export const saveImage = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    return await ctx.db.insert('images', { storageId });
  },
});
```

**Client side**:

```tsx
import * as ImagePicker from 'expo-image-picker';
import { useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';

function UploadButton() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveImage = useMutation(api.files.saveImage);

  const pickAndUpload = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    if (result.canceled) return;
    const asset = result.assets[0];

    // RN's fetch(uri).blob() works for the body, but blob.type is often empty —
    // use the picker's mimeType for the Content-Type header.
    const blob = await (await fetch(asset.uri)).blob();
    const contentType = asset.mimeType ?? 'image/jpeg';

    const uploadUrl = await generateUploadUrl();
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: blob,
    });
    const { storageId } = await res.json();

    await saveImage({ storageId });
  };

  return <Button onPress={pickAndUpload} title='Upload' />;
}
```

To display later, expose a query that returns `await ctx.storage.getUrl(storageId)` and pass that URL to `<Image source={url} />`.

## Upload to Supabase Storage

Per Supabase's own docs: _"For React Native, using either Blob, File or FormData does not work as intended. Upload file using ArrayBuffer from base64 file data instead."_ The pattern is **read the file as base64 → decode to ArrayBuffer → upload**.

```bash
npx expo install expo-file-system base64-arraybuffer
```

```ts
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { supabase } from '@/lib/supabase';

async function uploadImage(userId: string) {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
  });
  if (result.canceled) return;
  const asset = result.assets[0];

  // SDK 54+ File API. The legacy FileSystem.readAsStringAsync throws at runtime.
  const base64 = await new File(asset.uri).base64();
  const arrayBuffer = decode(base64);

  const contentType = asset.mimeType ?? 'image/jpeg';
  const ext = contentType.split('/')[1] ?? 'jpg';

  // Avatar: deterministic path + upsert (replaces in place, no graveyard)
  const path = `${userId}/avatar.${ext}`;
  const { data, error } = await supabase.storage
    .from('avatars')
    .upload(path, arrayBuffer, { contentType, upsert: true });

  // Gallery alternative: unique path, no upsert
  // const path = `${userId}/${Date.now()}.${ext}`;
  // .upload(path, arrayBuffer, { contentType });

  if (error) throw error;
  return data.path;
}
```

### Displaying uploaded files

**Public bucket** — get a permanent URL:

```ts
const { data } = supabase.storage.from('avatars').getPublicUrl(path);
<Image source={data.publicUrl} />;
```

**Private bucket** — must download and convert (RN can't fetch private URLs with auth headers in `<Image>`):

```ts
const { data: blob } = await supabase.storage.from('files').download(path);
const reader = new FileReader();
reader.readAsDataURL(blob!);
reader.onload = () => setUri(reader.result as string); // 'data:image/...;base64,...'
```

For private buckets at scale, prefer a **signed URL** instead of round-tripping bytes:

```ts
const { data } = await supabase.storage
  .from('files')
  .createSignedUrl(path, 3600); // valid 1 hour
<Image source={data!.signedUrl} />;
```

## Rules

- Always use `expo-image` over RN `Image`. Set `contentFit` explicitly; default is `'cover'`.
- Use `placeholder` (blurhash/thumbhash) + `transition` to avoid flicker on remote images.
- Set `recyclingKey` in any list (FlatList/FlashList) to prevent stale image frames.
- Picker/manipulator/media-library all require a native rebuild after install.
- Request permissions **before** launching the picker on iOS — especially for videos — to avoid surprise system dialogs.
- Prefer `useImageManipulator` + `renderAsync().saveAsync()` over the deprecated `manipulateAsync`.
- Use the array form `mediaTypes: ['images']`; `MediaTypeOptions` is deprecated.
- Always check `result.canceled` before reading `result.assets`.
- For upload `Content-Type` headers, use `asset.mimeType` from the picker — `blob.type` from `fetch(uri).blob()` is often empty in React Native.
- **Supabase from RN:** upload an **ArrayBuffer**, not a Blob (Blob uploads silently produce 0-byte files). Use the SDK 54 `File` class — the legacy `FileSystem.readAsStringAsync` is deprecated and throws at runtime. Public buckets → `getPublicUrl`. Private buckets → signed URL (preferred) or `download()` + `FileReader.readAsDataURL`.
- **Convex from RN:** a Blob body works fine; just supply an explicit `Content-Type`. You must define both `generateUploadUrl` and your own row-persisting mutation in `convex/`.
