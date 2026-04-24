---
name: expo-image-media
description: Use when implementing image display, image picking, camera capture, or media handling in React Native. Trigger on "image", "photo", "camera", "gallery", "image picker", "expo-image", "media", "blurhash", or displaying/uploading user photos.
---

# Expo Image & Media

## expo-image

Performant image component — use instead of React Native's Image because it supports caching, blurhash placeholders, and transitions.

```tsx
import { Image } from "expo-image";

<Image
  source={{ uri: "https://example.com/photo.jpg" }}
  style={{ width: 200, height: 200, borderRadius: 12 }}
  contentFit="cover"
  placeholder={{ blurhash: "LEHV6nWB2yk8pyoJadR*.7kCMdnj" }}
  transition={200}
/>
```

## expo-image-picker (requires install + rebuild)

```bash
npx expo install expo-image-picker
```

```tsx
import * as ImagePicker from "expo-image-picker";

const pickImage = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });

  if (!result.canceled) {
    const uri = result.assets[0].uri;
    // Upload to Convex storage or use locally
  }
};

const takePhoto = async () => {
  const result = await ImagePicker.launchCameraAsync({
    allowsEditing: true,
    quality: 0.8,
  });
  // ...
};
```

## app.json permissions

```json
{
  "expo": {
    "plugins": [
      [
        "expo-image-picker",
        {
          "photosPermission": "Allow access to your photos to upload images.",
          "cameraPermission": "Allow access to your camera to take photos."
        }
      ]
    ]
  }
}
```

## Rules

- Always use `expo-image` (already installed) over RN `Image`
- `expo-image-picker` and `expo-camera` require native rebuild
- Update `app.json` with permissions when using camera/photos
- Always handle `result.canceled` check
