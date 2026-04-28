---
name: expo-video
description: Reference and usage guide for `expo-video`, the cross-platform Expo library for video playback in React Native. Use this skill whenever the user wants to play, control, preload, cache, or stream video in an Expo / React Native app — including phrases like "video player", "play a video", "VideoView", "useVideoPlayer", "expo-video", "HLS", "DASH", "DRM", "Picture in Picture", "background playback", "fullscreen video", "subtitle track", "video thumbnail", "AirPlay", or migrating from the deprecated `expo-av` Video API. Also use this whenever the user is working with `.mp4`, `.m3u8`, livestreams, or media-library video assets in an Expo app.
---

# Expo Video (`expo-video`)

`expo-video` is the modern, cross-platform video component for Expo and React Native. It supersedes the older `expo-av` Video component and works on Android, iOS, tvOS, and Web (and is included in Expo Go).

The API has two parts that work together:

- **`<VideoView>`** — the React component that displays video on screen.
- **`VideoPlayer`** — a native object that owns playback state. You create one with `useVideoPlayer(...)` and pass it to `<VideoView player={...} />`.

This separation is intentional: one player can drive multiple views, survive remounts, and preload a video before any view is mounted.

Use this skill any time the user is working with `expo-video`.

## Installation

```sh
npx expo install expo-video
```

For bare React Native apps, install `expo` and configure Expo Modules first.

## Config plugin (build-time setup)

For features that require native config (background playback, Picture-in-Picture), add the config plugin to `app.json`:

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

These options take effect only after a new build (CNG / EAS Build) — they cannot be toggled at runtime. If the user is on Expo Go and only needs PiP/background playback during a development build, mention this. See `references/configuration.md` for what each flag changes in `Info.plist` and `AndroidManifest.xml`.

## The minimal example

This is the canonical "play / pause" pattern. Recommend it as the starting point for almost every use case:

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

Three things to internalize from this:

1. **`useVideoPlayer(source, setup?)`** creates and owns the player. The optional `setup` callback runs once after creation — use it for initial config (`loop`, `volume`, `currentTime`, autoplay).
2. **Player property changes do NOT trigger React re-renders.** Setting `player.muted = true` mutates native state but doesn't re-render. To reflect player state in UI, subscribe to events (next section).
3. **`<VideoView>` is mostly a presentation layer.** It handles display, fullscreen, PiP, and the native controls UI — but playback state lives on the player.

## Reacting to player state — events

Because `VideoPlayer` properties don't update React state on their own, you must listen for events. Three patterns, in order of preference:

### `useEvent` — for values you want to render

Returns a stateful value that triggers re-renders. Best when the value drives the UI directly.

```tsx
import { useEvent } from 'expo';

const { status, error } = useEvent(player, 'statusChange', {
  status: player.status,
});
const { isPlaying } = useEvent(player, 'playingChange', {
  isPlaying: player.playing,
});
```

The third argument is the **initial value** before the first event arrives — usually pass the player's current property so the first render has correct data.

### `useEventListener` — for side effects

Best when the event triggers a side effect (logging, analytics, navigation) rather than UI.

```tsx
import { useEventListener } from 'expo';

useEventListener(player, 'statusChange', ({ status, error }) => {
  console.log('Player status:', status, error);
});
```

### `player.addListener` — manual control

Use only when the hook patterns don't fit (subscribing outside a component, conditional subscriptions). You're responsible for cleanup.

```tsx
useEffect(() => {
  const sub = player.addListener('playToEnd', () => navigation.goBack());
  return () => sub.remove();
}, []);
```

For the full event list and payload shapes, see `references/events.md`.

## Video sources

A `VideoSource` can be:

- A **string URI** — `'https://.../video.mp4'`, `'https://.../stream.m3u8'`, or a `PHAsset` URI on iOS.
- A **local asset** via `require('./video.mp4')`.
- An **object** (`VideoSourceObject`) — needed for headers, DRM, caching, metadata, or content-type overrides.
- `null` — creates an empty player you can fill later via `replace()` / `replaceAsync()`.

```tsx
// String URI
useVideoPlayer('https://example.com/video.mp4');

// Local require()
useVideoPlayer(require('./assets/intro.mp4'));

// Full object
useVideoPlayer({
  uri: 'https://example.com/stream.m3u8',
  contentType: 'hls',
  headers: { Authorization: 'Bearer ...' },
  useCaching: true,
  metadata: { title: 'Stream', artist: 'Channel', artwork: 'https://...' },
});
```

For HLS, DASH, smooth streaming, DRM, headers, caching, and `PHAsset` quirks, see `references/sources-and-streaming.md`.

## Common patterns

### Replacing the source

```tsx
await player.replaceAsync(newSource); // Preferred — async on iOS
player.play();
```

`replace()` exists but loads synchronously on the iOS UI thread (it can stutter) and is being deprecated. Default to `replaceAsync()`.

### Preloading

A `VideoPlayer` starts buffering as soon as it has a source — even before being attached to a view. Create the next player in advance and swap it into a `<VideoView>` when ready:

```tsx
const player1 = useVideoPlayer(currentSource, (p) => p.play());
const player2 = useVideoPlayer(nextSource); // Preloads in the background

const [active, setActive] = useState(player1);

// Later: setActive(player2); player2.play();
```

### Local files and `require`

```tsx
const asset = require('./assets/clip.mp4');
const player = useVideoPlayer(asset);
// Or, with metadata:
useVideoPlayer({ assetId: asset, metadata: { title: 'Clip' } });
```

### Media library videos

Request permission via `expo-media-library`, then pass `asset.uri` (not `localUri` on iOS — it lacks read permissions):

```tsx
await MediaLibrary.requestPermissionsAsync(false, ['video']);
const { assets } = await MediaLibrary.getAssetsAsync({ mediaType: 'video' });
await player.replaceAsync(assets[0].uri);
```

### Caching

```tsx
useVideoPlayer({ uri, useCaching: true });
```

Cache is persistent and LRU-evicted. Default size is 1GB.

```tsx
import {
  setVideoCacheSizeAsync,
  getCurrentVideoCacheSize,
  clearVideoCacheAsync,
} from 'expo-video';
```

Cache management functions can only be called when **no `VideoPlayer` instances exist**. Caveats: HLS caching is unsupported on iOS, and DRM caching is unsupported on both platforms.

### Fullscreen, Picture-in-Picture, AirPlay

```tsx
<VideoView
  player={player}
  fullscreenOptions={{ enable: true }}
  allowsPictureInPicture
  startsPictureInPictureAutomatically // PiP when app backgrounds
/>
```

For AirPlay, set `player.allowsExternalPlayback = true` and add `<VideoAirPlayButton />` (iOS).

For details on `ButtonOptions`, fullscreen options, surface types, AirPlay button props, and ref methods (`enterFullscreen()`, `startPictureInPicture()`, etc.), see `references/videoview-props.md`.

### Subtitle and audio tracks

```tsx
const { availableSubtitleTracks } = player;
player.subtitleTrack = availableSubtitleTracks[0]; // or null to disable
player.audioTrack = player.availableAudioTracks[0];
```

Always assign a track from the `available*Tracks` arrays — don't construct one manually. Listen to `availableSubtitleTracksChange` if tracks load asynchronously (HLS, DASH).

### Generating thumbnails

```tsx
const [thumb] = await player.generateThumbnailsAsync([10.5], { maxWidth: 320 });
// thumb is a SharedRef<'image'> — use it as a source for expo-image:
// <Image source={thumb} style={{ width, height }} />
```

Pass an array of times (in seconds) for multiple thumbs. Android/iOS only.

### Background playback and Now-Playing notification

Requires `supportsBackgroundPlayback: true` in the config plugin, then on the player:

```tsx
player.staysActiveInBackground = true;
player.showNowPlayingNotification = true;
```

The Now-Playing notification uses `metadata` from the source (`title`, `artist`, `artwork`).

## Direct player creation (advanced)

`useVideoPlayer` auto-releases when the component unmounts. If you genuinely need a player that outlives the component (rare — usually a singleton service), use:

```tsx
import { createVideoPlayer } from 'expo-video';
const player = createVideoPlayer(source);
// You MUST call player.release() yourself, or you'll leak native memory.
```

Default to the hook unless there's a clear reason not to.

## Common pitfalls

- **Forgetting events.** Mutating `player.muted` or `player.currentTime` won't update React state. If the UI looks "stuck," the user is almost certainly reading a property without subscribing to its change event.
- **Two overlapping `<VideoView>`s with `contentFit="cover"`.** A known upstream Android bug renders one out of bounds. Workaround: set `surfaceType="textureView"` on Android.
- **Multiple `<VideoView>`s sharing one player on Android.** Not supported (platform limitation). One player per visible view on Android.
- **HLS without the `.m3u8` extension on iOS.** Video tracks won't be detected. Either use an `.m3u8` URL or set `contentType: 'hls'` on the source.
- **Calling cache management functions while a player exists.** `setVideoCacheSizeAsync` and `clearVideoCacheAsync` require zero live `VideoPlayer` instances.
- **`localUri` on iOS for media-library assets.** It lacks read permissions — use `asset.uri`.
- **Expecting PiP/background playback to work without the config plugin.** Both require build-time native config; setting runtime props alone is insufficient.

## Quick checklist when writing code

- Imports come from `'expo-video'` (`useVideoPlayer`, `VideoView`, `createVideoPlayer`, `VideoAirPlayButton`, cache helpers) and `'expo'` (`useEvent`, `useEventListener`).
- Default to `useVideoPlayer` over `createVideoPlayer`.
- Subscribe to events for any player property that drives the UI.
- `<VideoView>` has an explicit size in `style` (or `flex: 1` inside a sized parent).
- For PiP / background playback, the `expo-video` config plugin is added in `app.json` and a new build is required.
- Prefer `replaceAsync()` over `replace()`.
- HLS/DASH sources include the right extension or set `contentType` explicitly.

## Further reference

The detailed reference material is split into supporting files. Read these on demand — don't load them upfront:

- `references/events.md` — every event name, payload shape, and platform support.
- `references/videoview-props.md` — full prop list for `<VideoView>` and `<VideoAirPlayButton>`, plus imperative ref methods.
- `references/player-api.md` — full `VideoPlayer` property and method reference, plus `BufferOptions`, `ScrubbingModeOptions`, `SeekTolerance`.
- `references/sources-and-streaming.md` — `VideoSource` shape, `ContentType`, DRM (`DRMOptions`, `DRMType`), headers, caching rules, `PHAsset` URIs, livestream metadata.
- `references/configuration.md` — config plugin flags and what they change natively.
