---
name: expo-image-media
description: Image display (`expo-image`), picking/capture (`expo-image-picker`), transformation (`expo-image-manipulator`), and media library (`expo-media-library`).
---

# Expo Image & Media

Four packages: **expo-image** (display), **expo-image-picker** (capture/select), **expo-image-manipulator** (transform), **expo-media-library** (save/query).

## expo-image — Display

Always prefer over RN `Image`.

```tsx
import { Image } from 'expo-image';

const blurhash = 'LEHV6nWB2yk8pyoJadR*.7kCMdnj';

<Image
  source='https://example.com/photo.jpg'
  style={{ width: 200, height: 200, borderRadius: 12 }}
  contentFit='cover' // 'cover' | 'contain' | 'fill' | 'none' | 'scale-down'
  placeholder={{ blurhash }} // or { thumbhash } or local require()
  placeholderContentFit='cover'
  transition={300}
  cachePolicy='memory-disk' // 'none' | 'disk' | 'memory' | 'memory-disk'
  priority='normal' // 'low' | 'normal' | 'high'
  recyclingKey={item.id} // use in lists
/>;
```

**Static methods**:
- `Image.prefetch(urls, { cachePolicy: 'memory-disk' })`
- `Image.clearMemoryCache()` / `Image.clearDiskCache()`
- `Image.generateBlurhashAsync(uri, [4, 3])`

**SF Symbols on iOS**: `<Image source="sf:star.fill" tintColor="#facc15" />`

## expo-image-picker — Pick / Capture

```bash
npx expo install expo-image-picker
```

```tsx
import * as ImagePicker from 'expo-image-picker';

const [status, requestPermission] = ImagePicker.useMediaLibraryPermissions();

const pickImage = async () => {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], // array form; or ["images", "videos"]
    allowsEditing: true,
    aspect: [1, 1], // Android only; iOS crop is always square
    quality: 0.8,
    allowsMultipleSelection: false,
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
  if (!result.canceled) { /* result.assets[0].uri */ }
};
```

`MediaTypeOptions` is deprecated — use string arrays `["images"]`, `["videos"]`, `["livePhotos"]`.

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
    .resize({ width: 800 })
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

await MediaLibrary.saveToLibraryAsync(localUri);

const asset = await MediaLibrary.createAssetAsync(localUri);
const album = await MediaLibrary.getAlbumAsync('MyApp');
if (album) await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
else await MediaLibrary.createAlbumAsync('MyApp', asset, false);
```

## app.json — Permissions plugin config

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

```ts
// convex/files.ts
import { mutation } from './_generated/server';
import { v } from 'convex/values';

export const generateUploadUrl = mutation(async (ctx) => {
  return await ctx.storage.generateUploadUrl();
});

export const saveImage = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    return await ctx.db.insert('images', { storageId });
  },
});
```

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

## Upload to Supabase Storage

Per Supabase: For React Native, use **ArrayBuffer** from base64 (Blob/File/FormData don't work).

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

  // SDK 54+ File API. Legacy FileSystem.readAsStringAsync throws.
  const base64 = await new File(asset.uri).base64();
  const arrayBuffer = decode(base64);

  const contentType = asset.mimeType ?? 'image/jpeg';
  const ext = contentType.split('/')[1] ?? 'jpg';

  // Avatar: deterministic path + upsert
  const path = `${userId}/avatar.${ext}`;
  const { data, error } = await supabase.storage
    .from('avatars')
    .upload(path, arrayBuffer, { contentType, upsert: true });

  // Gallery alternative:
  // const path = `${userId}/${Date.now()}.${ext}`;
  // .upload(path, arrayBuffer, { contentType });

  if (error) throw error;
  return data.path;
}
```

### Displaying uploaded files

**Public bucket**:

```ts
const { data } = supabase.storage.from('avatars').getPublicUrl(path);
<Image source={data.publicUrl} />;
```

**Private bucket** — signed URL (preferred):

```ts
const { data } = await supabase.storage
  .from('files')
  .createSignedUrl(path, 3600);
<Image source={data!.signedUrl} />;
```

Or download + convert:

```ts
const { data: blob } = await supabase.storage.from('files').download(path);
const reader = new FileReader();
reader.readAsDataURL(blob!);
reader.onload = () => setUri(reader.result as string);
```

## Rules

- Always use `expo-image` over RN `Image`. Set `contentFit` explicitly.
- Use `placeholder` (blurhash/thumbhash) + `transition` to avoid flicker.
- Set `recyclingKey` in lists.
- Picker/manipulator/media-library require native rebuild after install.
- Request permissions **before** launching the picker on iOS.
- Use `useImageManipulator` over deprecated `manipulateAsync`.
- Use `mediaTypes: ['images']` (array form).
- Always check `result.canceled` before reading `result.assets`.
- Use `asset.mimeType` for `Content-Type` (blob.type is often empty in RN).
- **Supabase RN:** ArrayBuffer not Blob. SDK 54 `File` class. Public → `getPublicUrl`. Private → signed URL.
- **Convex RN:** Blob body works; supply explicit `Content-Type`.
