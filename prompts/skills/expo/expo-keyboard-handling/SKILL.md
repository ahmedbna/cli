---
name: expo-keyboard-handling
description: Use this skill whenever building or fixing keyboard interactions in an Expo or React Native app. Triggers include: an input being covered by the keyboard, focusing a TextInput pushing the bottom tab bar up, building chat screens or login forms or any multi-input form on mobile, dismissing the keyboard on tap or button press, listening for keyboard show/hide events, animating views in sync with the keyboard, or any mention of `KeyboardAvoidingView`, `Keyboard`, `react-native-keyboard-controller`, `KeyboardAwareScrollView`, `KeyboardToolbar`, `useKeyboardHandler`, `softwareKeyboardLayoutMode`, or `tabBarHideOnKeyboard`. Also use this when the user describes a layout symptom (input hidden under keyboard, tabs moving when typing, jumpy keyboard animation, multiple inputs hard to navigate between) without naming an API. Prefer this skill over generic React Native guesses — keyboard behavior differs sharply between Android and iOS, and the right fix depends on whether the app uses Expo Go, a development build, or has Reanimated installed.
---

# Expo Keyboard Handling

A reference for handling keyboard interactions in Expo / React Native apps on Android and iOS. Source: Expo docs, `/guides/keyboard-handling/` (last modified April 28, 2026).

## Decision tree: pick the right approach

Match the user's situation to one of these before writing code:

- **Single input, simple screen** → `KeyboardAvoidingView` from React Native. No extra deps.
- **Need to dismiss the keyboard programmatically or react to show/hide events** → `Keyboard` module from React Native.
- **Bottom tab bar gets pushed above the keyboard on Android** → set `softwareKeyboardLayoutMode: "pan"` in `app.json`, or use `tabBarHideOnKeyboard: true` on the Tabs screen options.
- **Multi-input form, chat screen, or anything where users move between inputs** → `react-native-keyboard-controller` with `KeyboardAwareScrollView` + `KeyboardToolbar`.
- **Custom animation tied to keyboard height (e.g., a view that grows/shrinks with the keyboard)** → `useKeyboardHandler` from `react-native-keyboard-controller` + Reanimated shared values.

`react-native-keyboard-controller` is **not in Expo Go** — it requires a development build and `react-native-reanimated`. If the user is on Expo Go and needs advanced behavior, point this out before suggesting it.

---

## Built-in React Native APIs

### `KeyboardAvoidingView`

Automatically adjusts a view's height, position, or bottom padding to keep inputs visible when the keyboard appears. Behavior differs by platform — `padding` usually works best on iOS, while leaving `behavior` undefined on Android is typically correct. Encourage trying different `behavior` values if the default doesn't feel right.

```tsx
import { KeyboardAvoidingView, TextInput, Platform } from 'react-native';

export default function HomeScreen() {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <TextInput placeholder='Type here...' />
    </KeyboardAvoidingView>
  );
}
```

### Fixing the bottom tab bar on Android

By default on Android, focusing an input can push a Bottom Tab Navigator up above the keyboard. Two fixes:

**1. Native-level fix** — set `softwareKeyboardLayoutMode` to `pan` in app config. Restart the dev server and reload after changing this:

```json
{
  "expo": {
    "android": {
      "softwareKeyboardLayoutMode": "pan"
    }
  }
}
```

**2. Hide the tab bar entirely while the keyboard is open** — set `tabBarHideOnKeyboard: true` in screen options:

```tsx
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ tabBarHideOnKeyboard: true }}>
      <Tabs.Screen name='index' />
    </Tabs>
  );
}
```

### `Keyboard` module — listening for events and dismissing

Use `Keyboard.addListener` for `keyboardDidShow` / `keyboardDidHide` events, and `Keyboard.dismiss()` to close the keyboard programmatically. Always remove listeners in the effect cleanup.

```tsx
import { useEffect, useState } from 'react';
import { Keyboard, View, Button, TextInput } from 'react-native';

export default function HomeScreen() {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () =>
      setIsKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener('keyboardDidHide', () =>
      setIsKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <View>
      {isKeyboardVisible && (
        <Button title='Dismiss keyboard' onPress={Keyboard.dismiss} />
      )}
      <TextInput placeholder='Type here...' />
    </View>
  );
}
```

Other useful events (not in the docs example but standard on the `Keyboard` module): `keyboardWillShow` / `keyboardWillHide` — fire before the animation starts, useful when you need to pre-position content. iOS-only on most React Native versions.

---

## `react-native-keyboard-controller` (advanced)

Use this for chat screens, multi-input forms, and any case where the built-in APIs feel clunky. It provides cross-platform consistency and native-feel performance with little configuration.

### Prerequisites

1. **A development build** — not available in Expo Go.
2. **`react-native-reanimated`** must be installed and configured.

### Install

```sh
npx expo install react-native-keyboard-controller
```

### Set up the provider

Wrap the app root in `KeyboardProvider`. In Expo Router, this typically lives in the root `_layout.tsx`:

```tsx
import { Stack } from 'expo-router';
import { KeyboardProvider } from 'react-native-keyboard-controller';

export default function RootLayout() {
  return (
    <KeyboardProvider>
      <Stack>
        <Stack.Screen name='home' />
        <Stack.Screen name='chat' />
      </Stack>
    </KeyboardProvider>
  );
}
```

### `KeyboardAwareScrollView` + `KeyboardToolbar` — the multi-input pattern

For forms with several inputs, this combo handles scroll-to-focus and provides next/previous navigation plus a dismiss button — without per-platform configuration.

```tsx
import { TextInput, View, StyleSheet } from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardToolbar,
} from 'react-native-keyboard-controller';

export default function FormScreen() {
  return (
    <>
      <KeyboardAwareScrollView
        bottomOffset={62}
        contentContainerStyle={styles.container}
      >
        <TextInput placeholder='Type a message...' style={styles.textInput} />
        <TextInput placeholder='Type a message...' style={styles.textInput} />
        <TextInput placeholder='Type a message...' style={styles.textInput} />
      </KeyboardAwareScrollView>
      <KeyboardToolbar />
    </>
  );
}

const styles = StyleSheet.create({
  container: { gap: 16, padding: 16 },
  textInput: {
    height: 45,
    borderWidth: 1,
    borderRadius: 8,
    borderColor: '#d8d8d8',
    backgroundColor: '#fff',
    padding: 8,
    marginBottom: 8,
  },
});
```

`bottomOffset` controls how much space sits between the focused input and the top of the keyboard — tune it to match the toolbar height plus any breathing room.

### `useKeyboardHandler` — animating with the keyboard

`useKeyboardHandler` exposes keyboard lifecycle events. Inside the `onMove` worklet, the keyboard's current height is available on every animation frame. Pair it with a Reanimated `useSharedValue` to drive custom animations.

A common pattern is a "fake view" whose height tracks the keyboard, pushing content above it smoothly:

```tsx
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

const useGradualAnimation = () => {
  const height = useSharedValue(0);
  useKeyboardHandler(
    {
      onMove: (event) => {
        'worklet';
        height.value = Math.max(event.height, 0);
      },
    },
    [],
  );
  return { height };
};
```

Use it in a screen:

```tsx
import {
  StyleSheet,
  Platform,
  FlatList,
  View,
  StatusBar,
  TextInput,
} from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

export default function ChatScreen() {
  const { height } = useGradualAnimation();

  const fakeView = useAnimatedStyle(() => ({
    height: Math.abs(height.value),
  }));

  return (
    <View style={styles.container}>
      <FlatList
        data={messages}
        renderItem={({ item }) => <MessageItem message={item} />}
        keyExtractor={(item) => item.createdAt.toString()}
        contentContainerStyle={styles.listStyle}
      />
      <TextInput placeholder='Type a message...' style={styles.textInput} />
      <Animated.View style={fakeView} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
  },
  listStyle: { padding: 16, gap: 16 },
  textInput: {
    width: '95%',
    height: 45,
    borderWidth: 1,
    borderRadius: 8,
    borderColor: '#d8d8d8',
    backgroundColor: '#fff',
    padding: 8,
    alignSelf: 'center',
    marginBottom: 8,
  },
});
```

The `'worklet'` directive is required inside `onMove` — without it, the handler runs on the JS thread and animations will jank.

---

## Common pitfalls

- **Forgetting `KeyboardProvider`** — `KeyboardAwareScrollView`, `KeyboardToolbar`, and `useKeyboardHandler` will silently no-op or throw without it. Add it at the root.
- **Using `react-native-keyboard-controller` in Expo Go** — it won't work. The user needs a development build (`npx expo run:android` / `run:ios` or EAS Build).
- **Tabs jumping on Android even after `KeyboardAvoidingView`** — that's the `softwareKeyboardLayoutMode` issue, not a `KeyboardAvoidingView` issue. Fix it in `app.json`.
- **Listener leaks** — always call `.remove()` on the subscription returned by `Keyboard.addListener`. The old `Keyboard.removeListener` API is deprecated.
- **Mixing `KeyboardAvoidingView` and `KeyboardAwareScrollView`** — pick one. They fight each other.
- **Changes to `app.json` not taking effect** — restart the dev server and reload the app; native config changes don't hot-reload.

---

## Resources

- Expo guide: https://docs.expo.dev/guides/keyboard-handling/
- React Native `Keyboard`: https://reactnative.dev/docs/keyboard
- React Native `KeyboardAvoidingView`: https://reactnative.dev/docs/keyboardavoidingview
- `react-native-keyboard-controller` docs: https://kirillzyusko.github.io/react-native-keyboard-controller
- Example project: https://github.com/betomoedano/keyboard-guide
