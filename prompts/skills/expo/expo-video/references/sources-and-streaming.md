# Video sources, streaming, DRM, and caching

## `VideoSource` shape

A `VideoSource` is one of:

```ts
type VideoSource =
  | string // URI
  | number // require()'d asset
  | null // empty player
  | VideoSourceObject;
```

### `VideoSourceObject`

```ts
{
  uri?: string;             // Mutually exclusive with assetId. Wins if both are set.
  assetId?: number;         // From require('./video.mp4')
  contentType?: ContentType; // 'auto' (default), 'progressive', 'hls', 'dash', 'smoothStreaming' (Android only)
  headers?: Record<string, string>;  // Sent with every request for this source. NOT for DRM headers.
  drm?: DRMOptions;
  metadata?: { title?: string; artist?: string; artwork?: string };
  useCaching?: boolean;     // Default false
}
```

`uri` and `assetId` are mutually exclusive — if both are set, `uri` wins and `assetId` is ignored.

## `ContentType` and streaming protocols

```ts
type ContentType = 'auto' | 'progressive' | 'hls' | 'dash' | 'smoothStreaming';
```

- `'auto'` — infer from URL/extension. The default. Works for `.mp4`, `.m3u8`, `.mpd`.
- `'progressive'` — standard MP4-style download. The fallback when no extension is present.
- `'hls'` — HLS. **On iOS, set this explicitly if the URL doesn't end in `.m3u8`** or video tracks won't be detected.
- `'dash'` — Android only.
- `'smoothStreaming'` — Android only.

When in doubt (e.g. signed CDN URLs without extensions), set `contentType` explicitly.

```tsx
useVideoPlayer({
  uri: 'https://cdn.example.com/signed-token-no-extension',
  contentType: 'hls',
});
```

## Headers

Generic headers (auth tokens, custom user-agents) go on the source:

```tsx
{
  uri,
  headers: { Authorization: 'Bearer ...', 'User-Agent': 'MyApp/1.0' },
}
```

For DRM license-server headers, use `DRMOptions.headers` instead — they're sent only on license requests, not on segment requests.

## DRM

```ts
type DRMOptions = {
  type: DRMType; // 'clearkey' | 'fairplay' | 'playready' | 'widevine'
  licenseServer: string;
  headers?: Record<string, string>;
  // FairPlay-specific (iOS):
  certificateUrl?: string;
  base64CertificateData?: string; // Wins over certificateUrl when both set
  contentId?: string;
  // Android-specific:
  multiKey?: boolean;
};
```

Platform support:

- Android: ClearKey, PlayReady, Widevine
- iOS: FairPlay

```tsx
// Widevine (Android)
useVideoPlayer({
  uri: 'https://example.com/video.mpd',
  contentType: 'dash',
  drm: {
    type: 'widevine',
    licenseServer: 'https://license.example.com/widevine',
    headers: { 'X-AxDRM-Message': '...' },
  },
});

// FairPlay (iOS)
useVideoPlayer({
  uri: 'https://example.com/video.m3u8',
  contentType: 'hls',
  drm: {
    type: 'fairplay',
    licenseServer: 'https://license.example.com/fps',
    certificateUrl: 'https://license.example.com/fps/cert',
    contentId: 'asset-id',
  },
});
```

DRM-protected videos **cannot be cached** on either Android or iOS.

## Caching

Set `useCaching: true` on the source:

```tsx
useVideoPlayer({ uri, useCaching: true });
```

Behavior:

- Persistent across app launches.
- LRU eviction once the preferred size is exceeded.
- The system may also clear the cache under storage pressure — don't rely on it for persistence.
- Works offline: if a video (or part of it) is cached, it plays without a network connection until the cached portion is exhausted.

Limitations:

- **HLS sources cannot be cached on iOS.** (Platform limitation.)
- **DRM-protected videos cannot be cached** on Android or iOS.

Management API (top-level imports from `'expo-video'`):

```ts
setVideoCacheSizeAsync(sizeBytes: number): Promise<void>  // Default 1GB
getCurrentVideoCacheSize(): number                         // Bytes
clearVideoCacheAsync(): Promise<void>
```

`setVideoCacheSizeAsync` and `clearVideoCacheAsync` require **no live `VideoPlayer` instances** to be present. Call them at app startup or after explicitly releasing players.

## Local files

```tsx
const asset = require('./assets/intro.mp4');

// As a source directly:
useVideoPlayer(asset);

// Or as part of an object (to attach metadata, etc.):
useVideoPlayer({
  assetId: asset,
  metadata: { title: 'Intro', artist: 'My App' },
});
```

## Media library (`expo-media-library`) videos

Always request video permissions first, and on iOS use `asset.uri` (not `asset.localUri` — it lacks the read permissions baked into the `PHAsset` URI).

```tsx
import * as MediaLibrary from 'expo-media-library';

const { granted } = await MediaLibrary.requestPermissionsAsync(false, [
  'video',
]);
if (!granted) return;

const { assets } = await MediaLibrary.getAssetsAsync({ mediaType: 'video' });
if (assets.length === 0) return;

await player.replaceAsync({
  uri: assets[0].uri,
  metadata: { title: assets[0].filename },
});
player.play();
```

`PHAsset` URIs on iOS have one extra constraint: they can only be loaded via `replaceAsync()` or via the default `VideoPlayer` constructor — not via `replace()`.

## Livestream metadata

For HLS livestreams with `EXT-X-PROGRAM-DATE-TIME`, two read-only properties are populated:

- `player.currentLiveTimestamp` — wall-clock time of the currently displayed frame, or `null`.
- `player.currentOffsetFromLive` — latency in seconds, or `null`.

`player.isLive` reports whether the source is a livestream.

On iOS, `player.targetOffsetFromLive` lets you tune the desired latency.

## Quick reference: when to set `contentType` explicitly

| Situation                                  | Set `contentType`?                                   |
| ------------------------------------------ | ---------------------------------------------------- |
| `.mp4` URL                                 | No (auto works)                                      |
| `.m3u8` URL                                | No (auto works), but harmless to set `'hls'`         |
| `.mpd` URL on Android                      | No (auto works)                                      |
| HLS URL with no `.m3u8` extension on iOS   | **Yes** — `'hls'`, otherwise video tracks won't load |
| Any signed/tokenized URL with no extension | Yes — set the actual protocol                        |
| SmoothStreaming on Android                 | Yes — `'smoothStreaming'`                            |
