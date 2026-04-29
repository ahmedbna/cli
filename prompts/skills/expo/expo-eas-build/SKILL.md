---
name: expo-eas-build
description: EAS Build for cloud builds, build profiles, OTA updates, and App Store/Play Store submission.
---

# EAS Build (Expo Application Services)

## Setup

```bash
npm install -g eas-cli
eas login
eas build:configure   # creates eas.json
```

## eas.json profiles

```json
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
```

## Build commands

```bash
# Dev build (with dev client, for testing native modules)
eas build --platform ios --profile development
eas build --platform android --profile development

# Preview build (internal distribution)
eas build --platform all --profile preview

# Production build (App Store / Play Store)
eas build --platform all --profile production
```

## OTA Updates (JS only)

```bash
eas update --branch production --message "Fix typo"
```

OTA pushes JS changes without a new native build. Only for non-native changes.

## Environment variables

```json
{
  "build": {
    "production": {
      "env": {
        "EXPO_PUBLIC_CONVEX_URL": "https://..."
      }
    }
  }
}
```
