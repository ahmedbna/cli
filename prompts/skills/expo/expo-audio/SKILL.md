---
name: expo-audio
description: Audio playback and recording with `expo-audio` — sound effects, music players, voice recording, playlists, background audio, and lock screen controls.
---

# Expo Audio

```sh
npx expo install expo-audio
```

## Core API

- **Hooks**: `useAudioPlayer`, `useAudioPlayerStatus`, `useAudioRecorder`, `useAudioRecorderState`, `useAudioPlaylist`, `useAudioPlaylistStatus`, `useAudioSampleListener`
- **Functions**: `setAudioModeAsync`, `setIsAudioActiveAsync`, `preload`, `createAudioPlayer`, `createAudioPlaylist`
- **Module**: `AudioModule.requestRecordingPermissionsAsync()`, `AudioModule.getRecordingPermissionsAsync()`
- **Constants**: `RecordingPresets.HIGH_QUALITY`, `RecordingPresets.LOW_QUALITY`, `AudioQuality`, `IOSOutputFormat`

## 1. Playback

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

**Player methods**: `play()`, `pause()`, `seekTo(seconds)`, `replace(source)`, `remove()`
**Writable props**: `volume` (0–1), `muted`, `loop`, `playbackRate`, `shouldCorrectPitch`
**Status fields**: `playing`, `isLoaded`, `isBuffering`, `currentTime`, `duration`, `didJustFinish`, `error`

⚠️ Only use `createAudioPlayer` (not the hook) when the player must outlive the component — and call `player.remove()` yourself, or it leaks.

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
    console.log('Recorded file:', recorder.uri);
  };

  return (
    <Button
      title={state.isRecording ? 'Stop' : 'Record'}
      onPress={state.isRecording ? stop : start}
    />
  );
}
```

Flow: permission → `setAudioModeAsync({ allowsRecording: true })` → `prepareToRecordAsync()` → `record()` → `stop()`. File URI on `recorder.uri` after stopping.

## 3. Audio mode

```tsx
await setAudioModeAsync({
  playsInSilentMode: true, // play even when iOS is on silent
  shouldPlayInBackground: true,
  allowsRecording: false, // set true only while recording
  interruptionMode: 'doNotMix', // 'doNotMix' | 'duckOthers' | 'mixWithOthers'
});
```

Toggle `allowsRecording` off after recording ends so iOS playback volume returns.

## 4. Background playback + lock screen controls

```json
{
  "expo": {
    "plugins": [["expo-audio", { "enableBackgroundPlayback": true }]]
  }
}
```

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

⚠️ **Android**: without `setActiveForLockScreen`, background audio stops after ~3 minutes.

Clear: `player.clearLockScreenControls()` or `setActiveForLockScreen(false)`.

## 5. Microphone permission plugin

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

For background recording add `"enableBackgroundRecording": true` and call `setAudioModeAsync({ allowsBackgroundRecording: true })`.

## 6. Playlists

```tsx
const playlist = useAudioPlaylist({
  sources: [require('./a.mp3'), 'https://example.com/b.mp3'],
  loop: 'all', // 'none' | 'single' | 'all'
});
// playlist.play() / pause() / next() / previous() / skipTo(i) / add(src) / remove(i)
```

## 7. Recording presets

- `RecordingPresets.HIGH_QUALITY` → 44.1kHz, stereo, 128kbps, .m4a/AAC
- `RecordingPresets.LOW_QUALITY` → 64kbps, smaller files

For custom: pass `RecordingOptions` with `extension`, `sampleRate`, `numberOfChannels`, `bitRate`, plus `android: { outputFormat, audioEncoder }` and `ios: { outputFormat, audioQuality }`.

## 8. Preloading

```tsx
import { preload } from 'expo-audio';

// At MODULE scope, before components render:
preload('https://example.com/track.mp3');

const player = useAudioPlayer('https://example.com/track.mp3');
```

## Common gotchas

- **No sound on iOS silent switch**: set `playsInSilentMode: true`.
- **Recording silent/distorted**: forgot `allowsRecording: true` before `prepareToRecordAsync()`.
- **Lock screen controls don't appear**: `interruptionMode` not `'doNotMix'`, or plugin not added (rebuild required).
- **Android background stops after 3 min**: missing `setActiveForLockScreen(true, ...)`.
- **Memory leak**: used `createAudioPlayer` and didn't call `.remove()`.
- **Web**: HTTPS required for mic access. Pass `crossOrigin: 'anonymous'` if you need CORS-enabled audio data.
- **Config plugin changes** require a rebuild, not a JS reload.
