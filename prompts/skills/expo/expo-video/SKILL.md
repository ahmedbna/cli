---
name: expo-video
description: Video playback with `expo-video` — `<VideoView>` + `useVideoPlayer`, HLS/DASH, DRM, PiP, AirPlay, caching, and tracks.
---

# Expo Video (`expo-video`)

Modern video component. Two parts:
- **`<VideoView>`** — display component.
- **`VideoPlayer`** — native object owning playback state. Create with `useVideoPlayer(...)`.

## Install

```sh
npx expo install expo-video
```

## Config plugin (build-time)

For background playback / Picture-in-Picture, add to `app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "expo-video",
        {
          "supportsBackgroundPlayback": true,
          "supportsPictureInPicture": true
        }
      ]
    ]
  }
}
```

Requires a new build (CNG/EAS Build) — cannot toggle at runtime.

## Minimal example

```tsx
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { StyleSheet, View, Button } from 'react-native';

const videoSource =
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

export default function VideoScreen() {
  const player = useVideoPlayer(videoSource, (player) => {
    player.loop = true;
    player.play();
  });

  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });

  return (
    <View style={styles.contentContainer}>
      <VideoView
        style={styles.video}
        player={player}
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture
      />
      <Button
        title={isPlaying ? 'Pause' : 'Play'}
        onPress={() => (isPlaying ? player.pause() : player.play())}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  contentContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  video: { width: 350, height: 275 },
});
```

Key points:
1. `useVideoPlayer(source, setup?)` creates the player. `setup` runs once.
2. **Player property changes do NOT trigger React re-renders.** Subscribe to events.
3. `<VideoView>` is presentation. Playback state lives on the player.

## Reacting to player state — events

### `useEvent` — for values you want to render

```tsx
import { useEvent } from 'expo';

const { status, error } = useEvent(player, 'statusChange', {
  status: player.status,
});
const { isPlaying } = useEvent(player, 'playingChange', {
  isPlaying: player.playing,
});
```

Third arg is the **initial value** before the first event arrives.

### `useEventListener` — for side effects

```tsx
import { useEventListener } from 'expo';

useEventListener(player, 'statusChange', ({ status, error }) => {
  console.log('Player status:', status, error);
});
```

### `player.addListener` — manual control

```tsx
useEffect(() => {
  const sub = player.addListener('playToEnd', () => navigation.goBack());
  return () => sub.remove();
}, []);
```

### Event list

| Event                          | Payload                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `playingChange`                | `{ isPlaying, oldIsPlaying? }`                                       |
| `statusChange`                 | `{ status, oldStatus?, error? }` — `'idle'\|'loading'\|'readyToPlay'\|'error'` |
| `mutedChange`                  | `{ muted, oldMuted? }`                                               |
| `volumeChange`                 | `{ volume, oldVolume? }`                                             |
| `playbackRateChange`           | `{ playbackRate, oldPlaybackRate? }`                                 |
| `sourceChange`                 | `{ source, oldSource? }` — fires on `replace`/`replaceAsync`         |
| `sourceLoad`                   | `{ videoSource, duration, availableAudioTracks, availableSubtitleTracks, availableVideoTracks }` |
| `playToEnd`                    | (no payload) fires before loop restart                               |
| `timeUpdate`                   | `{ currentTime, bufferedPosition, currentLiveTimestamp, currentOffsetFromLive }` — only if `timeUpdateEventInterval > 0` |
| `audioTrackChange`             | `{ audioTrack, oldAudioTrack? }`                                     |
| `availableAudioTracksChange`   |                                                                      |
| `subtitleTrackChange`          | `{ subtitleTrack, oldSubtitleTrack? }`                               |
| `availableSubtitleTracksChange`|                                                                      |
| `videoTrackChange`             | `{ videoTrack, oldVideoTrack? }`                                     |
| `isExternalPlaybackActiveChange` | iOS — AirPlay start/stop                                            |

## Video sources

A `VideoSource` can be:
- **String URI** — `'https://.../video.mp4'`, `'https://.../stream.m3u8'`, `PHAsset` URI on iOS.
- **Local asset** via `require('./video.mp4')`.
- **Object** (`VideoSourceObject`) — for headers, DRM, caching, metadata.
- **`null`** — empty player; fill later via `replaceAsync()`.

```tsx
useVideoPlayer({
  uri: 'https://example.com/stream.m3u8',
  contentType: 'hls',
  headers: { Authorization: 'Bearer ...' },
  useCaching: true,
  metadata: { title: 'Stream', artist: 'Channel', artwork: 'https://...' },
});
```

### `VideoSourceObject` shape

```ts
{
  uri?: string;             // Mutually exclusive with assetId. uri wins.
  assetId?: number;         // From require('./video.mp4')
  contentType?: ContentType;
  headers?: Record<string, string>;
  drm?: DRMOptions;
  metadata?: { title?: string; artist?: string; artwork?: string };
  useCaching?: boolean;     // Default false
}
```

### `ContentType`

```ts
type ContentType = 'auto' | 'progressive' | 'hls' | 'dash' | 'smoothStreaming';
```

| Situation                                  | Set `contentType`?                                   |
| ------------------------------------------ | ---------------------------------------------------- |
| `.mp4` URL                                 | No                                                   |
| `.m3u8` URL                                | No                                                   |
| `.mpd` URL on Android                      | No                                                   |
| HLS URL with no `.m3u8` extension on iOS   | **Yes** — `'hls'`, otherwise video tracks won't load |
| Any signed/tokenized URL with no extension | Yes                                                  |
| SmoothStreaming on Android                 | Yes — `'smoothStreaming'`                            |

## VideoPlayer API

### Properties

**Playback control**:

| Property           | Type                  | Default | Notes                                      |
| ------------------ | --------------------- | ------- | ------------------------------------------ |
| `playing`          | `boolean` (read-only) | —       | Use `play()`/`pause()`                     |
| `currentTime`      | `number`              | —       | Seconds. Setting it seeks.                 |
| `duration`         | `number` (read-only)  | —       | Seconds                                    |
| `playbackRate`     | `number`              | `1.0`   | Range `0`–`16.0`                           |
| `preservesPitch`   | `boolean`             | `true`  | Pitch correction during rate changes       |
| `volume`           | `number`              | `1.0`   | Range `0`–`1.0`                            |
| `muted`            | `boolean`             | `false` |                                            |
| `loop`             | `boolean`             | `false` |                                            |
| `status`           | (read-only)           | —       | `'idle'\|'loading'\|'readyToPlay'\|'error'`|
| `bufferedPosition` | `number` (read-only)  | —       | Seconds buffered                           |

**Tracks** (Android, iOS): `audioTrack`, `availableAudioTracks`, `subtitleTrack`, `availableSubtitleTracks`, `videoTrack`, `availableVideoTracks`.

**Live**: `isLive`, `currentLiveTimestamp`, `currentOffsetFromLive`, `targetOffsetFromLive` (iOS).

**External** (iOS): `allowsExternalPlayback`, `isExternalPlaybackActive`.

**System integration**:

| Property                     | Type      | Default  | Notes                                                  |
| ---------------------------- | --------- | -------- | ------------------------------------------------------ |
| `staysActiveInBackground`    | `boolean` | `false`  | Requires `supportsBackgroundPlayback` plugin           |
| `showNowPlayingNotification` | `boolean` | `false`  | On Android also requires `supportsBackgroundPlayback`  |
| `keepScreenOnWhilePlaying`   | `boolean` | `true`   | Android: only when a `VideoView` is visible            |
| `audioMixingMode`            | enum      | `'auto'` | `'mixWithOthers'\|'duckOthers'\|'auto'\|'doNotMix'`    |

**Tuning**: `bufferOptions`, `seekTolerance`, `scrubbingModeOptions`, `timeUpdateEventInterval` (default `0` = no event).

### Methods

```ts
player.play()
player.pause()
player.replay()                       // seek to 0
player.seekBy(seconds)                // approximate (seekTolerance)
player.replaceAsync(source)           // preferred
player.replace(source, disableWarning?) // sync; deprecated path on iOS
player.generateThumbnailsAsync(times, { maxWidth?, maxHeight? })
```

### Type details

**`AudioMixingMode`**: `doNotMix` > `auto` > `duckOthers` > `mixWithOthers`. Now-Playing notification on iOS requires `'doNotMix'` or `'auto'`.

**`BufferOptions`** — replace the entire object:

```ts
{
  preferredForwardBufferDuration?: number; // Android default 20, iOS default 0
  minBufferForPlayback?: number;           // Android default 2
  maxBufferBytes?: number | null;          // Android. 0 = auto
  prioritizeTimeOverSizeThreshold?: boolean; // Android default false
  waitsToMinimizeStalling?: boolean;       // iOS default true
}
```

**`SeekTolerance`**: `{ toleranceBefore?, toleranceAfter? }` — both default 0 (exact).

**`ScrubbingModeOptions`** for drag-to-scrub:

```ts
{
  scrubbingModeEnabled?: boolean; // toggle on while dragging, off when released
  // Android-only:
  allowSkippingMediaCodecFlush?: boolean;
  enableDynamicScheduling?: boolean;
  increaseCodecOperatingRate?: boolean;
  useDecodeOnlyFlag?: boolean;
}
```

**`PlayerBuilderOptions`** (Android, third arg to `useVideoPlayer`/`createVideoPlayer`, immutable):

```ts
{ seekForwardIncrement?: number; seekBackwardIncrement?: number }
```

## VideoView props

### Core

| Prop                    | Type                             | Default     | Notes                                            |
| ----------------------- | -------------------------------- | ----------- | ------------------------------------------------ |
| `player`                | `VideoPlayer \| null`            | —           |                                                  |
| `nativeControls`        | `boolean`                        | `true`      | Always on in fullscreen regardless               |
| `contentFit`            | `'contain'\|'cover'\|'fill'`     | `'contain'` | `cover` may crop, `fill` distorts                |
| `contentPosition` (iOS) | `{ dx, dy }`                     | —           |                                                  |

### Fullscreen

- `fullscreenOptions={{ enable: true }}`
- `onFullscreenEnter` / `onFullscreenExit`

### Picture-in-Picture

- `allowsPictureInPicture` — requires plugin flag.
- `startsPictureInPictureAutomatically` (Android 12+, iOS) — auto on backgrounding.
- `onPictureInPictureStart` / `onPictureInPictureStop`.

Only one player can be in PiP at a time.

### Lifecycle / rendering

- `onFirstFrameRender` — useful for hiding placeholders. May fire again on quality switch.
- `requiresLinearPlayback` — disallows skipping/scrubbing.
- `showsTimecodes` (iOS, default `true`).
- `allowsVideoFrameAnalysis` (iOS 16+, default `true`).

### Android-specific

- `surfaceType: 'surfaceView' | 'textureView'` (default `'surfaceView'`). Use `textureView` to fix overlapping `cover` videos. **Don't change at runtime.**
- `useExoShutter` (default `false`).
- `buttonOptions`: `{ showBottomBar?, showPlayPause?, showSeekForward?, showSeekBackward?, showSettings?, showNext?, showPrevious?, showSubtitles? }` — all default `true` except next/previous.

### Web

- `playsInline`
- `crossOrigin: 'anonymous' | 'use-credentials'`
- `useAudioNodePlayback` (experimental)

### Imperative ref methods

```ts
ref.enterFullscreen()
ref.exitFullscreen()
ref.startPictureInPicture()  // throws if unsupported
ref.stopPictureInPicture()
```

```ts
import { isPictureInPictureSupported } from 'expo-video';
if (isPictureInPictureSupported()) { /* ... */ }
```

## Common patterns

### Replacing the source

```tsx
await player.replaceAsync(newSource);
player.play();
```

Always prefer `replaceAsync()` over `replace()` (sync, blocks UI on iOS).

### Preloading

```tsx
const player1 = useVideoPlayer(currentSource, (p) => p.play());
const player2 = useVideoPlayer(nextSource); // Preloads in background
const [active, setActive] = useState(player1);
// Later: setActive(player2); player2.play();
```

### Local files

```tsx
const asset = require('./assets/clip.mp4');
const player = useVideoPlayer(asset);
// Or with metadata:
useVideoPlayer({ assetId: asset, metadata: { title: 'Clip' } });
```

### Media library videos

```tsx
import * as MediaLibrary from 'expo-media-library';

await MediaLibrary.requestPermissionsAsync(false, ['video']);
const { assets } = await MediaLibrary.getAssetsAsync({ mediaType: 'video' });
await player.replaceAsync(assets[0].uri); // use asset.uri (not localUri) on iOS
```

`PHAsset` URIs on iOS load only via `replaceAsync()` — not `replace()`.

### Caching

```tsx
useVideoPlayer({ uri, useCaching: true });
```

```tsx
import {
  setVideoCacheSizeAsync,
  getCurrentVideoCacheSize,
  clearVideoCacheAsync,
} from 'expo-video';
```

Default 1GB. Persistent + LRU evicted. Cache management requires **no live `VideoPlayer` instances**.

Limitations: HLS caching unsupported on iOS. DRM caching unsupported on both.

### DRM

```ts
type DRMOptions = {
  type: 'clearkey' | 'fairplay' | 'playready' | 'widevine';
  licenseServer: string;
  headers?: Record<string, string>;
  // FairPlay (iOS):
  certificateUrl?: string;
  base64CertificateData?: string; // wins over certificateUrl
  contentId?: string;
  // Android:
  multiKey?: boolean;
};
```

Platforms: Android — ClearKey, PlayReady, Widevine. iOS — FairPlay.

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

For DRM license-server headers, use `DRMOptions.headers` (sent only on license requests). Generic headers go on the source.

### Fullscreen, PiP, AirPlay

```tsx
<VideoView
  player={player}
  fullscreenOptions={{ enable: true }}
  allowsPictureInPicture
  startsPictureInPictureAutomatically
/>
```

For AirPlay: set `player.allowsExternalPlayback = true` and add `<VideoAirPlayButton />` (iOS).

```tsx
import { VideoAirPlayButton } from 'expo-video';

<VideoAirPlayButton
  style={{ width: 44, height: 44 }}
  tint='white'
  activeTint='dodgerblue'
/>;
```

`VideoAirPlayButton` props: `tint`, `activeTint`, `prioritizeVideoDevices` (default `true`), `onBeginPresentingRoutes`, `onEndPresentingRoutes`.

### Subtitle and audio tracks

```tsx
const { availableSubtitleTracks } = player;
player.subtitleTrack = availableSubtitleTracks[0]; // null to disable
player.audioTrack = player.availableAudioTracks[0];
```

Always assign from `available*Tracks`. Listen to `availableSubtitleTracksChange` for HLS/DASH async loads.

### Generating thumbnails

```tsx
const [thumb] = await player.generateThumbnailsAsync([10.5], { maxWidth: 320 });
// thumb is a SharedRef<'image'> — pass to expo-image:
// <Image source={thumb} style={{ width, height }} />
```

Pass an array of times for multiple thumbs. Android/iOS only.

### Background playback + Now-Playing

Requires `supportsBackgroundPlayback: true` plugin flag, then:

```tsx
player.staysActiveInBackground = true;
player.showNowPlayingNotification = true;
```

Now-Playing uses `metadata` from the source (`title`, `artist`, `artwork`).

## Direct player creation (advanced)

```tsx
import { createVideoPlayer } from 'expo-video';
const player = createVideoPlayer(source);
// MUST call player.release() yourself or leak native memory.
```

Default to the hook unless there's a clear reason not to.

## Track types

```ts
type AudioTrack = {
  label: string;
  language: string;
  name?: string; // Android, iOS
  id?: string;   // Android
  isDefault?: boolean;
  autoSelect?: boolean;
};
// SubtitleTrack same shape

type VideoTrack = {
  id: string;
  size: { width: number; height: number };
  averageBitrate: number | null;
  peakBitrate: number | null;
  bitrate: number | null; // deprecated
  frameRate: number | null;
  mimeType: string | null;
  url: string | null; // HLS only
  isSupported: boolean; // Android
};
```

## Common pitfalls

- **Forgetting events.** Property mutations don't update React state.
- **Two overlapping `<VideoView>`s with `contentFit="cover"`** — Android bug. Set `surfaceType="textureView"`.
- **Multiple `<VideoView>`s sharing one player on Android** — not supported. One player per visible view.
- **HLS without `.m3u8` extension on iOS** — set `contentType: 'hls'`.
- **Cache management with live players** — `setVideoCacheSizeAsync`/`clearVideoCacheAsync` require zero `VideoPlayer` instances.
- **`localUri` on iOS for media-library** — use `asset.uri` instead.
- **PiP/background without config plugin** — both require build-time native config.

## Checklist

- Imports from `'expo-video'` (`useVideoPlayer`, `VideoView`, `createVideoPlayer`, `VideoAirPlayButton`, cache helpers) and `'expo'` (`useEvent`, `useEventListener`).
- Default to `useVideoPlayer` over `createVideoPlayer`.
- Subscribe to events for player props that drive UI.
- `<VideoView>` has explicit size in `style`.
- For PiP/background, plugin in `app.json` + new build.
- Prefer `replaceAsync()` over `replace()`.
- HLS/DASH includes correct extension or `contentType` set.
