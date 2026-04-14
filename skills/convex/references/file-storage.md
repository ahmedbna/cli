# Convex File Storage

Store `storageId` (not URLs) in DB. Get URL on read: `await ctx.storage.getUrl(storageId)`

## Upload Flow

```ts
// convex/files.ts
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
```

## Schema

```ts
files: defineTable({
  userId: v.id("users"),
  storageId: v.id("_storage"),
}).index("by_user", ["userId"])
```

## React Native Upload

```tsx
import * as ImagePicker from "expo-image-picker";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

function UploadButton() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  const pickAndUpload = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (result.canceled) return;

    const uploadUrl = await generateUploadUrl();
    const response = await fetch(result.assets[0].uri);
    const blob = await response.blob();

    await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });

    // Extract storageId from the upload response
    const { storageId } = await fetch(uploadUrl).then(r => r.json());
    await saveFile({ storageId });
  };

  return <Button onPress={pickAndUpload} title="Upload" />;
}
```

## Delete stored file

```ts
export const deleteFile = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await ctx.storage.delete(storageId);
  },
});
```
