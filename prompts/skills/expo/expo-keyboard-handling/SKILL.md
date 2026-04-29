---
name: expo-keyboard-handling
description: Handle keyboard interactions in Expo/React Native — `KeyboardAvoidingView`, `Keyboard` events, `react-native-keyboard-controller` for forms/chat, and Android tab bar fixes.
---

# Expo Keyboard Handling

## Decision tree: pick the right approach

- **Single input, simple screen** → `KeyboardAvoidingView` from React Native.
- **Dismiss keyboard / react to show/hide events** → `Keyboard` module from React Native.
- **Bottom tab bar pushed above keyboard on Android** → `softwareKeyboardLayoutMode: "pan"` in `app.json`, or `tabBarHideOnKeyboard: true`.
- **Multi-input form, chat screen** → `react-native-keyboard-controller` with `KeyboardAwareScrollView` + `KeyboardToolbar`.
- **Custom animation tied to keyboard height** → `useKeyboardHandler` + Reanimated shared values.

`react-native-keyboard-controller` is **not in Expo Go** — needs a development build and `react-native-reanimated`.

## Built-in React Native APIs

### `KeyboardAvoidingView`

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

**1. Native-level fix** in `app.json`:

```json
{
  "expo": {
    "android": {
      "softwareKeyboardLayoutMode": "pan"
    }
  }
}
```

**2. Hide the tab bar while keyboard is open**:

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

### `Keyboard` module — events & dismissing

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

Other events: `keyboardWillShow` / `keyboardWillHide` (iOS-only on most RN versions).

## `react-native-keyboard-controller` (advanced)

### Prerequisites

- A development build (not Expo Go).
- `react-native-reanimated` installed and configured.

### Install

```sh
npx expo install react-native-keyboard-controller
```

### Provider — wrap app root

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

### `KeyboardAwareScrollView` + `KeyboardToolbar`

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
```

### `useKeyboardHandler` — animating with the keyboard

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

Use it:

```tsx
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
      />
      <TextInput placeholder='Type a message...' />
      <Animated.View style={fakeView} />
    </View>
  );
}
```

The `'worklet'` directive is required inside `onMove` — without it, animations jank.

## Common pitfalls

- **Forgetting `KeyboardProvider`** — `KeyboardAwareScrollView`/`KeyboardToolbar`/`useKeyboardHandler` will silently no-op or throw.
- **Using `react-native-keyboard-controller` in Expo Go** — needs a dev build.
- **Tabs jumping on Android** — that's `softwareKeyboardLayoutMode`, not `KeyboardAvoidingView`.
- **Listener leaks** — call `.remove()` on subscriptions. The old `Keyboard.removeListener` is deprecated.
- **Mixing `KeyboardAvoidingView` and `KeyboardAwareScrollView`** — pick one.
- **Changes to `app.json`** — restart dev server and reload; native config doesn't hot-reload.
