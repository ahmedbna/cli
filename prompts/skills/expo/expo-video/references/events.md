# `expo-video` events reference

`VideoPlayer` extends `SharedObject<VideoPlayerEvents>`. Subscribe via `useEvent`, `useEventListener` (both from the `expo` package), or `player.addListener(name, handler)`.

## Event list

All events are supported on Android, iOS, tvOS, and Web unless noted otherwise.

### `playingChange`

Emitted when playback starts or stops.

```ts
{ isPlaying: boolean; oldIsPlaying?: boolean }
```

### `statusChange`

Emitted when the player's overall status changes. The `status` value is one of `'idle' | 'loading' | 'readyToPlay' | 'error'`.

```ts
{ status: VideoPlayerStatus; oldStatus?: VideoPlayerStatus; error?: { message: string } }
```

Use this for loading spinners and error UI. `error` is only present when `status === 'error'`.

### `mutedChange`

```ts
{ muted: boolean; oldMuted?: boolean }
```

### `volumeChange`

```ts
{ volume: number; oldVolume?: number }
```

### `playbackRateChange`

```ts
{ playbackRate: number; oldPlaybackRate?: number }
```

### `sourceChange`

Emitted when `replace()` / `replaceAsync()` swaps the source.

```ts
{ source: VideoSource; oldSource?: VideoSource }
```

### `sourceLoad`

Emitted once metadata for a source has loaded (not the same as "ready to play" — buffering may still be ongoing).

```ts
{
  videoSource: VideoSource | null;
  duration: number;
  availableAudioTracks: AudioTrack[];
  availableSubtitleTracks: SubtitleTrack[];
  availableVideoTracks: VideoTrack[];
}
```

### `playToEnd`

Fires once when playback reaches the end of the current source. No payload. If `player.loop` is `true`, this still fires before the loop restarts.

### `timeUpdate`

Periodic playback progress, emitted at the interval set by `player.timeUpdateEventInterval` (in seconds). When the interval is `0` (the default), this event does **not** fire — set the interval first if you want it.

```ts
{
  currentTime: number;
  bufferedPosition: number; // Android, iOS
  currentLiveTimestamp: number | null; // Android, iOS
  currentOffsetFromLive: number | null; // Android, iOS
}
```

### `audioTrackChange`

```ts
{ audioTrack: AudioTrack | null; oldAudioTrack?: AudioTrack | null }
```

### `availableAudioTracksChange`

Emitted when the list of available audio tracks changes (e.g. HLS variant load).

### `subtitleTrackChange`

```ts
{ subtitleTrack: SubtitleTrack | null; oldSubtitleTrack?: SubtitleTrack | null }
```

### `availableSubtitleTracksChange`

Emitted when the list of available subtitle tracks changes.

### `videoTrackChange`

```ts
{ videoTrack: VideoTrack | null; oldVideoTrack?: VideoTrack | null }
```

### `isExternalPlaybackActiveChange` (iOS only)

Fired when AirPlay starts or stops.

```ts
{ isExternalPlaybackActive: boolean; oldIsExternalPlaybackActive?: boolean }
```

## Picking the right hook

- **`useEvent(player, 'eventName', initialValue)`** — when the value should drive rendering. Returns the latest payload as state.
- **`useEventListener(player, 'eventName', handler)`** — when the event triggers side effects (logging, analytics, navigation). No re-renders.
- **`player.addListener(...)`** — when neither hook fits (subscribing in a service, conditional subscriptions). Remember to call `subscription.remove()`.

## Example: a complete status-aware player

```tsx
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';

function Player({ source }: { source: string }) {
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.5;
    p.play();
  });

  const { status, error } = useEvent(player, 'statusChange', {
    status: player.status,
  });
  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });

  if (status === 'error') return <ErrorView message={error?.message} />;
  if (status === 'loading') return <Spinner />;

  return (
    <>
      <VideoView player={player} style={{ flex: 1 }} />
      <ProgressBar value={currentTime} max={player.duration} />
    </>
  );
}
```
