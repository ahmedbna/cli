export const expoDevBuildDocs = `
# Expo Dev Build Guide

## What is a Dev Build?
A dev build is a custom version of the Expo Go app that includes your project's native dependencies.
It replaces Expo Go and must be rebuilt whenever you add/change native modules.

## When to rebuild
Rebuild required after:
- \`npx expo install\` of any native package (camera, location, BLE, sensors, notifications, etc.)
- Changes to \`app.json\` plugins array
- Changes to native configuration

JS/Convex-only changes do NOT need a rebuild — just redeploy and reload.

## Build commands

### Local build (simulator/emulator)
\`\`\`bash
npx expo run:ios        # iOS simulator
npx expo run:android    # Android emulator or connected device
\`\`\`

## Common native packages requiring rebuild
| Package | Use case |
|---------|----------|
| expo-camera | Camera access |
| expo-location | GPS/location |
| expo-notifications | Push notifications |
| expo-sensors | Accelerometer, gyro, etc. |
| expo-media-library | Photo/video library |
| expo-image-picker | Image selection |
| expo-audio | Audio playback |
| expo-video | Video playback |
| react-native-ble-plx | Bluetooth |
| react-native-maps | Maps |

## Troubleshooting
- **"Module not found" or native crash**: Rebuild dev client
- **Metro bundler errors**: JS issue, no rebuild needed
- **Convex errors**: Backend issue, no rebuild needed
`;
