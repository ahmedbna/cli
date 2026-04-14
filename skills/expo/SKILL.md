---
name: expo-docs
description: Use this skill before implementing Expo and React Native features. Trigger when the agent needs to write code involving dev builds, EAS builds, file-based routing, image/media handling (expo-image, image picker, camera), animations (react-native-reanimated), haptics (expo-haptics), gestures (react-native-gesture-handler), or keyboard handling (react-native-keyboard-controller). Always read the relevant reference doc BEFORE writing implementation code.
---

# Expo & React Native Features Reference

This skill provides documentation for Expo and React Native features used in BNA apps.
The agent MUST read the relevant reference file before implementing any of these features.

## Available Topics

| Topic | File | When to read |
|-------|------|-------------|
| Dev Builds | `references/dev-build.md` | Understanding dev builds vs Expo Go, when to rebuild |
| EAS Builds | `references/eas-build.md` | Cloud builds, profiles, OTA updates |
| Routing | `references/routing.md` | File-based routing, tabs, navigation, dynamic routes |
| Image & Media | `references/image-media.md` | expo-image, image picker, camera |
| Animations | `references/animations.md` | react-native-reanimated (ALWAYS use this, never built-in Animated) |
| Haptics & Gestures | `references/haptics-gestures.md` | expo-haptics, gesture-handler, keyboard-controller |

## Key Rules

- ALWAYS use `react-native-reanimated` — NEVER React Native's built-in `Animated` API
- ALWAYS use `react-native-keyboard-controller` — NEVER `KeyboardAvoidingView`
- ALWAYS use `expo-image` instead of React Native's `Image` component
- This project uses Expo dev builds, NOT Expo Go
- When adding native modules, remind user to rebuild: `npx expo run:ios` / `npx expo run:android`
