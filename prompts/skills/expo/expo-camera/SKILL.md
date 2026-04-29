---
name: expo-camera
description: Camera preview, photo capture, video recording, and barcode/QR scanning with `expo-camera`. Test on real devices — does not run on simulators.
---

# Expo Camera

```sh
npx expo install expo-camera
```

**Does not run in iOS or Android simulators — test on a real device.**

## Core API

- **Component**: `CameraView`
- **Hooks**: `useCameraPermissions`, `useMicrophonePermissions`
- **Static methods on `CameraView`**: `launchScanner`, `dismissScanner`, `onModernBarcodeScanned`, `getAvailableVideoCodecsAsync`, `isAvailableAsync`
- **Module method**: `Camera.scanFromURLAsync(url, barcodeTypes?)`

⚠️ Only **one** `CameraView` can be active at a time. Unmount on screens that lose focus (use `useIsFocused()` from `@react-navigation/native`).

## 1. Permissions

```tsx
import { useCameraPermissions } from 'expo-camera';

const [permission, requestPermission] = useCameraPermissions();

if (!permission) return <View />;
if (!permission.granted) {
  return <Button title='Grant camera' onPress={requestPermission} />;
}
```

For video with audio, also `useMicrophonePermissions()`.

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

## 3. Take a photo

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
    if (!ready) return;
    const photo = await ref.current?.takePictureAsync({
      quality: 0.8,
      // base64: true, exif: true, skipProcessing: true,
    });
    if (photo) setUri(photo.uri);
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

⚠️ Photo `uri` is in cache — copy with `expo-file-system` for long-term storage.

## 4. Record video

```tsx
<CameraView ref={ref} mode='video' style={{ flex: 1 }} />;

const startRecording = async () => {
  const video = await ref.current?.recordAsync({
    maxDuration: 60,
    // maxFileSize: 50_000_000,
    // codec: 'hvc1',
  });
  console.log(video?.uri);
};

ref.current?.stopRecording();
```

**Gotchas**:
- Flipping `facing` mid-recording stops it.
- Set `mute` prop for silent video.
- Pause/resume: check `getSupportedFeatures().toggleRecordingAsyncAvailable` then call `toggleRecordingAsync()` (iOS 18+).

## 5. Scan barcodes / QR codes (live preview)

```tsx
<CameraView
  style={{ flex: 1 }}
  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
  onBarcodeScanned={({ type, data }) => {
    console.log(type, data);
  }}
/>
```

Supported types: `qr`, `ean13`, `ean8`, `upc_a`, `upc_e`, `code39`, `code93`, `code128`, `codabar`, `itf14`, `pdf417`, `aztec`, `datamatrix`.

⚠️ Fires on every frame. Debounce:

```tsx
const scanned = useRef(false);
onBarcodeScanned={({ data }) => {
  if (scanned.current) return;
  scanned.current = true;
  handle(data);
}}
```

### Native modal scanner (recommended for one-shot scans)

```tsx
import { CameraView } from 'expo-camera';

const sub = CameraView.onModernBarcodeScanned(({ type, data }) => {
  console.log(data);
  sub.remove();
  CameraView.dismissScanner();
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
| `enableTorch`            | `boolean`                                                 | flashlight                               |
| `zoom`                   | `0` to `1`                                                | percentage of max zoom                   |
| `mode`                   | `'picture'` \| `'video'`                                  |                                          |
| `mute`                   | `boolean`                                                 | record video without audio               |
| `mirror`                 | `boolean`                                                 | mirror front-cam                         |
| `videoQuality`           | `'2160p'` \| `'1080p'` \| `'720p'` \| `'480p'` \| `'4:3'` |                                          |
| `videoStabilizationMode` | `'off'` \| `'standard'` \| `'cinematic'` \| `'auto'`      |                                          |
| `pictureSize`            | from `getAvailablePictureSizesAsync()`                    | overrides `ratio`                        |
| `ratio`                  | `'4:3'` \| `'16:9'` \| `'1:1'`                            | Android only                             |
| `active`                 | `boolean`                                                 | iOS only — pause without unmount         |
| `animateShutter`         | `boolean`                                                 | default `true`                           |
| `onCameraReady`          | `() => void`                                              | wait before capturing                    |
| `onMountError`           | `(e) => void`                                             | preview failed to start                  |

## Common gotchas

- **Black preview**: testing on simulator. Use a real device.
- **`takePictureAsync` throws**: called before `onCameraReady`.
- **`onBarcodeScanned` fires hundreds of times**: debounce via `useRef`.
- **Photo file disappears**: cache dir; copy with `expo-file-system`.
- **Video sideways**: `skipProcessing: true` — remove or honor EXIF.
- **No audio**: missing mic permission.
- **Two cameras conflict**: only one active. Unmount with `useIsFocused()`.
- **Web**: HTTPS required.
- **iOS `videoBitrate` ignored**: also pass `codec`.
- **Plugin changes**: require native rebuild.
