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

# Preview build (internal distribution, no dev client)
eas build --platform all --profile preview

# Production build (App Store / Play Store)
eas build --platform all --profile production
```

## OTA Updates (JS only)

```bash
eas update --branch production --message "Fix typo"
```

OTA updates push JS changes without a new native build.
Only use for non-native changes.

## Environment variables in EAS

Set in eas.json or via dashboard:

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
