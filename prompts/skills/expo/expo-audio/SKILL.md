---
name: expo-audio
description: Implement audio playback and recording in Expo/React Native apps using expo-audio. Use when adding sound effects, music players, voice recording, audio playlists, background audio, lock screen controls, or audio visualization to an Expo app.
---

# Expo Audio

Cross-platform audio playback and recording for Expo React Native apps. Works on Android, iOS, tvOS, and Web.

## Install

```sh
npx expo install expo-audio
```

## Core API

Import from `expo-audio`:

- **Hooks**: `useAudioPlayer`, `useAudioPlayerStatus`, `useAudioRecorder`, `useAudioRecorderState`, `useAudioPlaylist`, `useAudioPlaylistStatus`, `useAudioSampleListener`
- **Functions**: `setAudioModeAsync`, `setIsAudioActiveAsync`, `preload`, `createAudioPlayer`, `createAudioPlaylist`
- **Module**: `AudioModule.requestRecordingPermissionsAsync()`, `AudioModule.getRecordingPermissionsAsync()`
- **Constants**: `RecordingPresets.HIGH_QUALITY`, `RecordingPresets.LOW_QUALITY`, `AudioQuality`, `IOSOutputFormat`

## 1. Playback (most common)

Use `useAudioPlayer` — the hook handles cleanup automatically.

```tsx
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

function Player() {
  const player = useAudioPlayer(require('./sound.mp3'));
  // Or: useAudioPlayer('https://example.com/audio.mp3')
  const status = useAudioPlayerStatus(player);

  return (
    <>
      <Button
        title={status.playing ? 'Pause' : 'Play'}
        onPress={() => (status.playing ? player.pause() : player.play())}
      />
      <Text>
        {status.currentTime.toFixed(1)} / {status.duration.toFixed(1)}s
      </Text>
    </>
  );
}
```

**Key player methods**: `play()`, `pause()`, `seekTo(seconds)`, `replace(source)`, `remove()`
**Key player props** (writable): `volume` (0–1), `muted`, `loop`, `playbackRate` (iOS 0–2, Android 0.1–2), `shouldCorrectPitch`
**Status fields**: `playing`, `isLoaded`, `isBuffering`, `currentTime`, `duration`, `didJustFinish`, `error`

⚠️ Only use `createAudioPlayer` (not the hook) when the player must outlive the component — and you MUST call `player.remove()` yourself, or it leaks.

## 2. Recording

```tsx
import {
  useAudioRecorder,
  useAudioRecorderState,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';

function Recorder() {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);

  useEffect(() => {
    (async () => {
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      if (!granted) return;
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
    })();
  }, []);

  const start = async () => {
    await recorder.prepareToRecordAsync();
    recorder.record();
  };
  const stop = async () => {
    await recorder.stop();
    console.log('Recorded file:', recorder.uri); // file URI
  };

  return (
    <Button
      title={state.isRecording ? 'Stop' : 'Record'}
      onPress={state.isRecording ? stop : start}
    />
  );
}
```

**Always**: request permission → `setAudioModeAsync({ allowsRecording: true })` → `prepareToRecordAsync()` → `record()` → `stop()`.

The output file path lives on `recorder.uri` after stopping.

## 3. Audio mode (call once at app start when relevant)

```tsx
await setAudioModeAsync({
  playsInSilentMode: true, // play even when iOS is on silent
  shouldPlayInBackground: true, // continue when app backgrounded
  allowsRecording: false, // set true only while recording
  interruptionMode: 'doNotMix', // 'doNotMix' | 'duckOthers' | 'mixWithOthers'
});
```

Toggle `allowsRecording` off after recording ends so playback volume returns to normal on iOS.

## 4. Background playback + lock screen controls

Add the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": [["expo-audio", { "enableBackgroundPlayback": true }]]
  }
}
```

Then at runtime:

```tsx
await setAudioModeAsync({
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: 'doNotMix', // REQUIRED for lock screen controls
});

player.setActiveForLockScreen(true, {
  title: 'Track Title',
  artist: 'Artist',
  albumTitle: 'Album',
  artworkUrl: 'https://example.com/art.jpg',
});
player.play();
```

⚠️ **Android**: without `setActiveForLockScreen`, background audio stops after ~3 minutes (OS limit). Always call it for sustained background playback.

To clear: `player.clearLockScreenControls()` or `player.setActiveForLockScreen(false)`.

## 5. Recording permissions on microphone (config plugin)

```json
{
  "expo": {
    "plugins": [
      [
        "expo-audio",
        {
          "microphonePermission": "Allow $(PRODUCT_NAME) to access your microphone."
        }
      ]
    ]
  }
}
```

For background recording add `"enableBackgroundRecording": true` (battery-heavy; only when needed) and call `setAudioModeAsync({ allowsBackgroundRecording: true })`.

## 6. Playlists (gapless multi-track)

```tsx
const playlist = useAudioPlaylist({
  sources: [require('./a.mp3'), 'https://example.com/b.mp3'],
  loop: 'all', // 'none' | 'single' | 'all'
});
// playlist.play() / pause() / next() / previous() / skipTo(i) / add(src) / remove(i)
```

## 7. Recording presets

`RecordingPresets.HIGH_QUALITY` → 44.1kHz, stereo, 128kbps, .m4a/AAC. Good default.
`RecordingPresets.LOW_QUALITY` → 64kbps, smaller files. Use for voice memos.

For custom options, pass a `RecordingOptions` object with `extension`, `sampleRate`, `numberOfChannels`, `bitRate`, plus `android: { outputFormat, audioEncoder }` and `ios: { outputFormat, audioQuality }`.

## 8. Preloading (instant playback)

```tsx
import { preload } from 'expo-audio';

// At MODULE scope, before components render:
preload('https://example.com/track.mp3');

// Later, useAudioPlayer/createAudioPlayer/replace() use the cached buffer:
const player = useAudioPlayer('https://example.com/track.mp3');
```

## Common gotchas

- **No sound on iOS silent switch**: set `playsInSilentMode: true` in `setAudioModeAsync`.
- **Recording is silent or distorted**: forgot `allowsRecording: true` before `prepareToRecordAsync()`.
- **Lock screen controls don't appear**: `interruptionMode` is not `'doNotMix'`, or config plugin not added (rebuild required).
- **Android background audio stops after 3 min**: missing `setActiveForLockScreen(true, ...)`.
- **Memory leak**: used `createAudioPlayer` instead of `useAudioPlayer` and didn't call `.remove()`.
- **Web recording quirks**: Chrome MediaRecorder produces WebM without duration metadata; HTTPS required for mic access.
- **Config plugin changes require a rebuild** (`npx expo prebuild` + native build), not a JS reload.

## Web-only notes

- Site must be HTTPS for mic access.
- Pass `crossOrigin: 'anonymous'` in `AudioPlayerOptions` if you need CORS-enabled audio data access.
