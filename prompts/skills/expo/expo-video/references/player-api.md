# `VideoPlayer` API reference

`VideoPlayer` is a native shared object. Mutate its properties to control playback; subscribe to events (see `events.md`) to read state in React.

Create one with:

```ts
useVideoPlayer(source, setup?, playerBuilderOptions?)  // preferred, auto-released
createVideoPlayer(source, playerBuilderOptions?)        // manual lifecycle, call .release() yourself
```

## Properties

### Playback control

| Property           | Type                            | Default | Notes                                                      |
| ------------------ | ------------------------------- | ------- | ---------------------------------------------------------- |
| `playing`          | `boolean` (read-only)           | —       | Use `play()` / `pause()` to change.                        |
| `currentTime`      | `number`                        | —       | Seconds. Setting it seeks.                                 |
| `duration`         | `number` (read-only)            | —       | Seconds.                                                   |
| `playbackRate`     | `number`                        | `1.0`   | Range `0`–`16.0`.                                          |
| `preservesPitch`   | `boolean`                       | `true`  | Pitch correction during rate changes.                      |
| `volume`           | `number`                        | `1.0`   | Range `0`–`1.0`. Independent of `muted`.                   |
| `muted`            | `boolean`                       | `false` | Doesn't change `volume`.                                   |
| `loop`             | `boolean`                       | `false` | Auto-replay on end.                                        |
| `status`           | `VideoPlayerStatus` (read-only) | —       | `'idle' \| 'loading' \| 'readyToPlay' \| 'error'`.         |
| `bufferedPosition` | `number` (read-only)            | —       | Seconds buffered. `0` if behind playback, `-1` if unknown. |

### Tracks (Android, iOS)

| Property                  | Type                             | Notes                                                              |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `audioTrack`              | `AudioTrack \| null`             | Currently playing audio track.                                     |
| `availableAudioTracks`    | `AudioTrack[]` (read-only)       | —                                                                  |
| `subtitleTrack`           | `SubtitleTrack \| null`          | Always assign one of `availableSubtitleTracks`.                    |
| `availableSubtitleTracks` | `SubtitleTrack[]` (read-only)    | —                                                                  |
| `videoTrack`              | `VideoTrack \| null` (read-only) | —                                                                  |
| `availableVideoTracks`    | `VideoTrack[]` (read-only)       | HLS sources need `.m3u8` extension or `contentType: 'hls'` on iOS. |

### Live streams (Android, iOS)

| Property                     | Type                         | Notes                                   |
| ---------------------------- | ---------------------------- | --------------------------------------- |
| `isLive`                     | `boolean` (read-only)        | True when the source is a livestream.   |
| `currentLiveTimestamp`       | `number \| null` (read-only) | From `EXT-X-PROGRAM-DATE-TIME` HLS tag. |
| `currentOffsetFromLive`      | `number \| null` (read-only) | Latency in seconds.                     |
| `targetOffsetFromLive` (iOS) | `number`                     | Desired live offset in seconds.         |

### External playback / AirPlay (iOS)

| Property                   | Type                  | Default | Notes                                    |
| -------------------------- | --------------------- | ------- | ---------------------------------------- |
| `allowsExternalPlayback`   | `boolean`             | `true`  | Required for the AirPlay button to work. |
| `isExternalPlaybackActive` | `boolean` (read-only) | —       | True while AirPlay is active.            |

### Background / system integration

| Property                     | Type                             | Default  | Notes                                                     |
| ---------------------------- | -------------------------------- | -------- | --------------------------------------------------------- |
| `staysActiveInBackground`    | `boolean` (Android, iOS)         | `false`  | Requires `supportsBackgroundPlayback` plugin flag.        |
| `showNowPlayingNotification` | `boolean` (Android, iOS)         | `false`  | On Android also requires `supportsBackgroundPlayback`.    |
| `keepScreenOnWhilePlaying`   | `boolean` (Android, iOS)         | `true`   | On Android, only effective when a `VideoView` is visible. |
| `audioMixingMode`            | `AudioMixingMode` (Android, iOS) | `'auto'` | See below.                                                |

### Buffering / seeking tuning

| Property                  | Type                   | Notes                                                                 |
| ------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `bufferOptions`           | `BufferOptions`        | Replace the whole object — individual fields can't be set. See below. |
| `seekTolerance`           | `SeekTolerance`        | `{ toleranceBefore, toleranceAfter }` in seconds. Default exact.      |
| `scrubbingModeOptions`    | `ScrubbingModeOptions` | Optimize for many quick seeks. See below.                             |
| `timeUpdateEventInterval` | `number`               | Default `0` (no `timeUpdate` events).                                 |

## Methods

### Playback

```ts
player.play(): void
player.pause(): void
player.replay(): void           // Seek to 0
player.seekBy(seconds: number): void   // Approximate (uses seekTolerance)
```

For frame-accurate seeking, set `currentTime` directly (with `seekTolerance` zeroed out, the default).

### Source replacement

```ts
player.replaceAsync(source: VideoSource): Promise<void>   // Preferred
player.replace(source: VideoSource, disableWarning?: boolean): void  // Sync, deprecated path on iOS
```

On Android and Web, `replaceAsync` is equivalent to `replace`. On iOS, `replace` blocks the UI thread while loading metadata — always prefer `replaceAsync`.

### Thumbnails

```ts
player.generateThumbnailsAsync(
  times: number | number[],
  options?: { maxWidth?: number; maxHeight?: number }
): Promise<VideoThumbnail[]>
```

`VideoThumbnail` is a `SharedRef<'image'>` — pass it as the `source` of `<Image>` from `expo-image`. Each thumbnail has `width`, `height`, `requestedTime`, and `actualTime` (iOS).

## Type details

### `AudioMixingMode`

How this player coexists with audio from other apps. Priority on a per-app basis: `doNotMix` > `auto` > `duckOthers` > `mixWithOthers`.

- `'mixWithOthers'` — play alongside other apps.
- `'duckOthers'` — lower other apps' volume while this one plays.
- `'auto'` — only allow other apps' audio when this player is muted. On iOS, always interrupts when `showNowPlayingNotification` is true.
- `'doNotMix'` — pause other apps' audio.

The Now-Playing notification on iOS requires `'doNotMix'` or `'auto'`.

### `BufferOptions`

Replace the entire object when changing any field.

```ts
{
  preferredForwardBufferDuration?: number; // Android, iOS. Android default 20, iOS default 0 (auto).
  minBufferForPlayback?: number;           // Android. Default 2.
  maxBufferBytes?: number | null;          // Android. 0 = auto.
  prioritizeTimeOverSizeThreshold?: boolean; // Android. Default false.
  waitsToMinimizeStalling?: boolean;       // iOS. Default true.
}
```

### `SeekTolerance`

```ts
{ toleranceBefore?: number; toleranceAfter?: number }  // Both default 0 (exact)
```

Larger values are usually faster. Affects `currentTime` setting and `seekBy()`.

### `ScrubbingModeOptions`

For UIs with rapid seeking (drag-to-scrub progress bars).

```ts
{
  scrubbingModeEnabled?: boolean; // Default false. Toggle on while user drags, off when they release.
  // Android-only fine-tuning (defaults true):
  allowSkippingMediaCodecFlush?: boolean;
  enableDynamicScheduling?: boolean;
  increaseCodecOperatingRate?: boolean;
  useDecodeOnlyFlag?: boolean;
}
```

When `scrubbingModeEnabled` is true on Android, playback is suppressed — turn it off when the user releases. On iOS, also pause during scrubbing for best results.

### `PlayerBuilderOptions` (Android only)

Passed to `useVideoPlayer` / `createVideoPlayer` as the third argument. Can't be changed after construction.

```ts
{
  seekForwardIncrement?: number;   // Seconds. Clamped to [0.001, 999].
  seekBackwardIncrement?: number;  // Seconds. Clamped to [0.001, 999].
}
```

## `AudioTrack`, `SubtitleTrack`, `VideoTrack`

```ts
type AudioTrack = {
  label: string;
  language: string;
  name?: string; // Android, iOS
  id?: string; // Android
  isDefault?: boolean;
  autoSelect?: boolean;
};

type SubtitleTrack = {
  // Same shape as AudioTrack
};

type VideoTrack = {
  id: string;
  size: { width: number; height: number };
  averageBitrate: number | null;
  peakBitrate: number | null;
  bitrate: number | null; // Deprecated — use peak/averageBitrate
  frameRate: number | null;
  mimeType: string | null;
  url: string | null; // HLS only
  isSupported: boolean; // Android
};
```

## Cache management functions

Top-level imports from `'expo-video'`:

```ts
setVideoCacheSizeAsync(sizeBytes: number): Promise<void>
getCurrentVideoCacheSize(): number
clearVideoCacheAsync(): Promise<void>
isPictureInPictureSupported(): boolean
```

`setVideoCacheSizeAsync` and `clearVideoCacheAsync` can only be called when **no `VideoPlayer` instances exist**. Default cache size is 1GB.
