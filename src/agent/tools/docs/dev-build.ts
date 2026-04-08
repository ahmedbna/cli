export const devBuild = `
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
npx expo run:android   # Android emulator or connected device
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

export const easBuild = `
# EAS Build (Expo Application Services)

## Setup
\`\`\`bash
npm install -g eas-cli
eas login
eas build:configure   # creates eas.json
\`\`\`

## eas.json profiles
\`\`\`json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "simulator": true }
    },
    "preview": {
      "distribution": "internal"
    },
    "production": {
      "autoIncrement": true
    }
  }
}
\`\`\`

## Build commands
\`\`\`bash
# Dev build (with dev client, for testing native modules)
eas build --platform ios --profile development
eas build --platform android --profile development

# Preview build (internal distribution, no dev client)
eas build --platform all --profile preview

# Production build (App Store / Play Store)
eas build --platform all --profile production
\`\`\`

## OTA Updates (JS only)
\`\`\`bash
eas update --branch production --message "Fix typo"
\`\`\`
OTA updates push JS changes without a new native build.
Only use for non-native changes.

## Environment variables in EAS
Set in eas.json or via dashboard:
\`\`\`json
{
  "build": {
    "production": {
      "env": {
        "EXPO_PUBLIC_CONVEX_URL": "https://..."
      }
    }
  }
}
\`\`\`
`;
