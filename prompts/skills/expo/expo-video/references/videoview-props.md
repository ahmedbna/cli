# `<VideoView>` and `<VideoAirPlayButton>` reference

`VideoView` is a `React.PureComponent<VideoViewProps>`. It also inherits all standard `ViewProps`.

## VideoView props

### Core

| Prop                    | Type                             | Default     | Notes                                                                           |
| ----------------------- | -------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `player`                | `VideoPlayer \| null`            | —           | The player instance from `useVideoPlayer` / `createVideoPlayer`.                |
| `nativeControls`        | `boolean`                        | `true`      | Show native playback controls. Always on in fullscreen regardless of this prop. |
| `contentFit`            | `'contain' \| 'cover' \| 'fill'` | `'contain'` | Scaling mode. `cover` may crop, `fill` distorts.                                |
| `contentPosition` (iOS) | `{ dx: number; dy: number }`     | —           | Offset of the video inside the container.                                       |

### Fullscreen

| Prop                | Type                | Notes                                                          |
| ------------------- | ------------------- | -------------------------------------------------------------- |
| `fullscreenOptions` | `FullscreenOptions` | Pass `{ enable: true }` to allow fullscreen via the native UI. |
| `onFullscreenEnter` | `() => void`        | Called after entering fullscreen.                              |
| `onFullscreenExit`  | `() => void`        | Called after exiting fullscreen.                               |

### Picture-in-Picture (Android, iOS, Web)

| Prop                                  | Type                         | Default | Notes                                                                        |
| ------------------------------------- | ---------------------------- | ------- | ---------------------------------------------------------------------------- |
| `allowsPictureInPicture`              | `boolean`                    | —       | Enables PiP. **Requires** the `supportsPictureInPicture` config plugin flag. |
| `startsPictureInPictureAutomatically` | `boolean` (Android 12+, iOS) | `false` | Auto-PiP on backgrounding.                                                   |
| `onPictureInPictureStart`             | `() => void`                 | —       | Called after entering PiP.                                                   |
| `onPictureInPictureStop`              | `() => void`                 | —       | Called after exiting PiP.                                                    |

Only one player can be in PiP at a time.

### Lifecycle / rendering

| Prop                                 | Type                       | Notes                                                                                                       |
| ------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `onFirstFrameRender`                 | `() => void`               | Useful for hiding a placeholder image. May fire again if the video track changes (e.g. HLS quality switch). |
| `requiresLinearPlayback`             | `boolean` (Android, iOS)   | Disallows skipping/scrubbing when `true`.                                                                   |
| `showsTimecodes` (iOS)               | `boolean` (default `true`) | Show timestamp labels in native controls.                                                                   |
| `allowsVideoFrameAnalysis` (iOS 16+) | `boolean` (default `true`) | Live Text on video frames.                                                                                  |

### Android-specific

| Prop            | Type                             | Default         | Notes                                                                             |
| --------------- | -------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| `surfaceType`   | `'surfaceView' \| 'textureView'` | `'surfaceView'` | Use `textureView` to fix overlapping `cover` videos. **Don't change at runtime.** |
| `useExoShutter` | `boolean`                        | `false`         | When `false`, behaves like iOS (no black shutter before first frame).             |
| `buttonOptions` | `ButtonOptions`                  | —               | Show/hide individual control buttons (see below).                                 |

### Web-specific

| Prop                   | Type                                            | Notes                                                                      |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `playsInline`          | `boolean`                                       | Inline playback within the page.                                           |
| `crossOrigin`          | `'anonymous' \| 'use-credentials' \| undefined` | CORS mode. Some CDNs reject CORS — leave undefined if videos fail to load. |
| `useAudioNodePlayback` | `boolean` (default `false`)                     | **Experimental.** Uses Web Audio Nodes; can break some sources.            |

## `ButtonOptions` (Android)

Controls visibility of native control bar buttons. Defaults shown.

```ts
{
  showBottomBar?: boolean;        // true
  showPlayPause?: boolean;        // true
  showSeekForward?: boolean;      // true
  showSeekBackward?: boolean;     // true
  showSettings?: boolean;         // true
  showNext?: boolean;             // false
  showPrevious?: boolean;         // false
  showSubtitles?: boolean | null; // undefined: only when subtitles available
}
```

The bottom bar is always visible in fullscreen so the user can exit. The fullscreen button is controlled by `fullscreenOptions.enable`, not here.

## Imperative ref methods

`<VideoView>` exposes a ref with these async methods (Android, iOS, tvOS, Web unless noted):

```ts
ref.enterFullscreen(): Promise<void>
ref.exitFullscreen(): Promise<void>
ref.startPictureInPicture(): Promise<void>  // throws if unsupported
ref.stopPictureInPicture(): Promise<void>
```

`startPictureInPicture()` requires the config plugin to be set up — same caveat as the `allowsPictureInPicture` prop.

To check support before calling:

```ts
import { isPictureInPictureSupported } from 'expo-video';
if (isPictureInPictureSupported()) {
  /* ... */
}
```

## `<VideoAirPlayButton>` (iOS only)

Renders an `AVRoutePickerView`. Requires `player.allowsExternalPlayback === true`.

| Prop                      | Type                       | Notes                                      |
| ------------------------- | -------------------------- | ------------------------------------------ |
| `tint`                    | `ColorValue`               | Icon color when AirPlay is **not** active. |
| `activeTint`              | `ColorValue`               | Icon color while AirPlay **is** active.    |
| `prioritizeVideoDevices`  | `boolean` (default `true`) | Show video outputs first in the picker.    |
| `onBeginPresentingRoutes` | `() => void`               | Picker about to appear.                    |
| `onEndPresentingRoutes`   | `() => void`               | Picker dismissed.                          |

Inherits `ViewProps` except `children`.

```tsx
import { VideoAirPlayButton } from 'expo-video';

<VideoAirPlayButton
  style={{ width: 44, height: 44 }}
  tint='white'
  activeTint='dodgerblue'
/>;
```
