---
name: expo-camera
description: Render a camera preview and take photos, record videos, or scan barcodes/QR codes in Expo/React Native apps using expo-camera. Use when adding camera capture, photo/video recording, QR or barcode scanning, torch/flash control, or front/back camera switching to an Expo app.
---

# Expo Camera

Camera preview, photo capture, video recording, and barcode/QR scanning for Expo React Native apps. Works on Android, iOS, and Web. **Does not run in iOS or Android simulators — test on a real device.**

## Install

```sh
npx expo install expo-camera
```

## Core API

Import from `expo-camera`:

- **Component**: `CameraView` (the preview + capture surface)
- **Hooks**: `useCameraPermissions`, `useMicrophonePermissions`
- **Static methods on `CameraView`**: `launchScanner`, `dismissScanner`, `onModernBarcodeScanned`, `getAvailableVideoCodecsAsync`, `isAvailableAsync`
- **Module method**: `Camera.scanFromURLAsync(url, barcodeTypes?)`

⚠️ Only **one** `CameraView` can be active at a time. Unmount it on screens that lose focus (use `useIsFocused()` from `@react-navigation/native`).

## 1. Permissions (always do this first)

```tsx
import { useCameraPermissions } from 'expo-camera';

const [permission, requestPermission] = useCameraPermissions();

if (!permission) return <View />; // still loading
if (!permission.granted) {
  return <Button title='Grant camera' onPress={requestPermission} />;
}
```

For video recording with audio, also call `useMicrophonePermissions()` the same way.

## 2. Config plugin (`app.json`)

```json
{
  "expo": {
    "plugins": [
      [
        "expo-camera",
        {
          "cameraPermission": "Allow $(PRODUCT_NAME) to access your camera",
          "microphonePermission": "Allow $(PRODUCT_NAME) to access your microphone",
          "recordAudioAndroid": true,
          "barcodeScannerEnabled": true
        }
      ]
    ]
  }
}
```

Set `barcodeScannerEnabled: false` to shrink the binary if you don't scan codes. Plugin changes need a rebuild (`npx expo prebuild`), not a JS reload.

## 3. Take a photo

Use a `ref` on `CameraView` to call `takePictureAsync()`.

```tsx
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';

export default function PhotoScreen() {
  const ref = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [uri, setUri] = useState<string | null>(null);

  if (!permission?.granted)
    return <Button onPress={requestPermission} title='Grant' />;

  const snap = async () => {
    if (!ready) return; // wait for onCameraReady
    const photo = await ref.current?.takePictureAsync({
      quality: 0.8, // 0 (small) - 1 (max)
      // base64: true,                         // include base64 string
      // exif: true,                           // include EXIF
      // skipProcessing: true,                 // faster but may rotate wrong
    });
    if (photo) setUri(photo.uri); // local file URI (cache dir)
  };

  return (
    <CameraView
      ref={ref}
      style={{ flex: 1 }}
      facing='back' // 'back' | 'front'
      flash='auto' // 'off' | 'on' | 'auto' | 'screen'
      onCameraReady={() => setReady(true)}
    />
  );
}
```

⚠️ Photo `uri` is in the **cache directory** and may be deleted by the OS. Copy it with `expo-file-system` if you need it long-term.

## 4. Record video

Set `mode="video"` on `CameraView`, then call `recordAsync()` / `stopRecording()`.

```tsx
<CameraView ref={ref} mode='video' style={{ flex: 1 }} />;

// start
const startRecording = async () => {
  // recordAsync resolves when stopRecording is called or limits hit
  const video = await ref.current?.recordAsync({
    maxDuration: 60, // seconds
    // maxFileSize: 50_000_000,
    // codec: 'hvc1',       // iOS only — needed for videoBitrate prop
  });
  console.log(video?.uri); // local file URI
};

// stop
ref.current?.stopRecording();
```

**Gotchas**:

- Flipping `facing` mid-recording stops it.
- For silent video, set `mute` prop on `CameraView`.
- For pause/resume mid-recording: check `getSupportedFeatures().toggleRecordingAsyncAvailable` then call `toggleRecordingAsync()` (iOS 18+).

## 5. Scan barcodes / QR codes (live preview)

```tsx
<CameraView
  style={{ flex: 1 }}
  barcodeScannerSettings={{ barcodeTypes: ['qr'] }} // or ['qr','ean13','code128',...]
  onBarcodeScanned={({ type, data }) => {
    console.log(type, data);
    // Debounce — onBarcodeScanned fires on every frame that detects a code
  }}
/>
```

Supported types: `qr`, `ean13`, `ean8`, `upc_a`, `upc_e`, `code39`, `code93`, `code128`, `codabar`, `itf14`, `pdf417`, `aztec`, `datamatrix`.

⚠️ `onBarcodeScanned` fires repeatedly. Track scanned state to avoid duplicates:

```tsx
const scanned = useRef(false);
onBarcodeScanned={({ data }) => {
  if (scanned.current) return;
  scanned.current = true;
  handle(data);
}}
```

### Native modal scanner (recommended for one-shot scans)

Uses Google ML Kit (Android) / `DataScannerViewController` (iOS 16+). Doesn't need a `CameraView`:

```tsx
import { CameraView } from 'expo-camera';

const sub = CameraView.onModernBarcodeScanned(({ type, data }) => {
  console.log(data);
  sub.remove();
  CameraView.dismissScanner(); // iOS only; Android auto-dismisses
});

await CameraView.launchScanner({ barcodeTypes: ['qr'] });
```

### Scan from a saved image

```tsx
import { Camera } from 'expo-camera';
const results = await Camera.scanFromURLAsync(imageUri, ['qr']);
```

## 6. Common `CameraView` props

| Prop                     | Values                                                    | Notes                                    |
| ------------------------ | --------------------------------------------------------- | ---------------------------------------- |
| `facing`                 | `'back'` \| `'front'`                                     | default `'back'`                         |
| `flash`                  | `'off'` \| `'on'` \| `'auto'` \| `'screen'`               | `'screen'` for selfie flash              |
| `enableTorch`            | `boolean`                                                 | flashlight (continuous)                  |
| `zoom`                   | `0` to `1`                                                | percentage of max zoom                   |
| `mode`                   | `'picture'` \| `'video'`                                  | switch before recording                  |
| `mute`                   | `boolean`                                                 | record video without audio               |
| `mirror`                 | `boolean`                                                 | mirror front-cam preview/output          |
| `videoQuality`           | `'2160p'` \| `'1080p'` \| `'720p'` \| `'480p'` \| `'4:3'` | falls back if unavailable                |
| `videoStabilizationMode` | `'off'` \| `'standard'` \| `'cinematic'` \| `'auto'`      |                                          |
| `pictureSize`            | string from `getAvailablePictureSizesAsync()`             | overrides `ratio`                        |
| `ratio`                  | `'4:3'` \| `'16:9'` \| `'1:1'`                            | Android only                             |
| `active`                 | `boolean`                                                 | iOS only — pause session without unmount |
| `animateShutter`         | `boolean`                                                 | default `true`                           |
| `onCameraReady`          | `() => void`                                              | wait for this before capturing           |
| `onMountError`           | `(e) => void`                                             | preview failed to start                  |

## 7. Pinch-to-zoom (basic pattern)

`zoom` is `0–1`. Pair with `react-native-gesture-handler`'s pinch gesture and clamp:

```tsx
const [zoom, setZoom] = useState(0);
// onPinch: setZoom(Math.min(1, Math.max(0, prevZoom + scale - 1)))
<CameraView zoom={zoom} ... />
```

## Common gotchas

- **Black preview / nothing renders**: testing on a simulator. Use a real device.
- **`takePictureAsync` throws or returns last frame**: called before `onCameraReady` fired, or while preview was paused.
- **`onBarcodeScanned` fires hundreds of times**: debounce via a `useRef` flag.
- **Photo file disappears later**: `uri` is in cache; copy it with `expo-file-system` before relying on it.
- **Video recorded sideways**: `skipProcessing: true` was set — remove it, or honor EXIF orientation downstream.
- **Recording starts but no audio**: missing `RECORD_AUDIO` (Android) or `NSMicrophoneUsageDescription` (iOS), or microphone permission not requested.
- **Two cameras in two screens conflict**: only one `CameraView` may be active. Unmount on blur with `useIsFocused()`.
- **Web: image `uri` is base64**: browsers don't expose file paths. Treat `uri` as a data string on web.
- **iOS `videoBitrate` prop ignored**: you must also pass `codec` to `recordAsync`.
- **Changing config plugin doesn't take effect**: requires a native rebuild.

## Web notes

- HTTPS required for camera access.
- In a cross-origin iframe, the parent must set `allow="camera; microphone;"`.
- Check device support with `await CameraView.isAvailableAsync()`.
