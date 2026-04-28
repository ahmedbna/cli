---
name: expo-safe-area-context
description: Use this skill whenever working with safe area insets in an Expo or React Native app — anything involving notches, the status bar, the home indicator, the dynamic island, rounded screen corners, or "content getting cut off at the top/bottom of the screen on a real device." Triggers include any mention of `react-native-safe-area-context`, `SafeAreaView`, `SafeAreaProvider`, `SafeAreaInsetsContext`, `useSafeAreaInsets`, `initialWindowMetrics`, `EdgeInsets`, "safe area," "notch," "status bar overlap," "home bar," or migration from CSS `env(safe-area-inset-*)` variables. Also use this when the user describes a symptom (text under the notch, button hidden behind the home indicator, header overlapping the status bar) without naming the API. Note: React Native's built-in `SafeAreaView` from `react-native` is iOS-only and deprecated for cross-platform use — always recommend the `react-native-safe-area-context` version instead.
---

# react-native-safe-area-context

A reference for the `react-native-safe-area-context` library, which provides safe area inset information so content avoids notches, status bars, the home indicator, and similar OS chrome. Source: Expo SDK docs (`/versions/latest/sdk/safe-area-context/`).

## When to reach for what

Three primary APIs cover most cases:

- **`SafeAreaView`** — drop-in replacement for `View` that pads itself by the safe area insets. Best default. Native implementation, no rotation jank.
- **`useSafeAreaInsets()`** — hook returning `{ top, right, bottom, left }`. Use when you need the raw numbers (custom layouts, applying insets to non-padding props like `marginTop`, conditional logic based on inset size).
- **`SafeAreaInsetsContext.Consumer`** — render-prop equivalent of the hook, for class components or contexts where hooks aren't available.

`SafeAreaProvider` is **required at the app root** for any of these to work (and is required on web even when only using `SafeAreaView`).

## Platforms

Supported on **Android, iOS, tvOS, and Web**. Included in **Expo Go** — no development build needed.

---

## Installation

```sh
npx expo install react-native-safe-area-context
```

For an existing bare React Native app, ensure `expo` is installed in the project, then follow the upstream installation instructions.

---

## Setup: `SafeAreaProvider`

Wrap the app root once. In Expo Router, this typically lives in `app/_layout.tsx`:

```tsx
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function App() {
  return <SafeAreaProvider>{/* ...rest of app */}</SafeAreaProvider>;
}
```

Add it inside modals and other detached route trees too — modals don't inherit the outer provider in some setups (notably with `react-native-screens`).

### Speeding up first render

Pass `initialWindowMetrics` to skip the async measurement on first render:

```tsx
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';

<SafeAreaProvider initialMetrics={initialWindowMetrics}>
  {/* ... */}
</SafeAreaProvider>;
```

Don't do this if the provider remounts during the app's lifecycle, or if the app uses `react-native-navigation` — the cached metrics will go stale.

### Web SSR

For server-side rendering, pass `initialSafeAreaInsets` with values for the target device, or pass zeroes. Without it, async inset measurement will block first paint.

---

## `SafeAreaView`

A `View` that applies the safe area as **padding**. Any padding set on it is added on top of the inset padding (not replaced).

```tsx
import { SafeAreaView } from 'react-native-safe-area-context';

function Screen() {
  return (
    <SafeAreaView>
      <View />
    </SafeAreaView>
  );
}
```

### Props

| Prop                     | Type      | Default                              | Notes                                                                                                                                       |
| ------------------------ | --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `edges`                  | `Edge[]`  | `['top', 'right', 'bottom', 'left']` | Which edges to inset. Pass a subset to only pad some sides — common pattern is `edges={['top']}` for screens with their own bottom tab bar. |
| `emulateUnlessSupported` | `boolean` | `true`                               | On iOS 10+, emulate the safe area using the status bar height and home indicator size when native insets aren't available.                  |

`Edge` is a string union: `'top' | 'right' | 'bottom' | 'left'`.

### Important: this is the _library's_ `SafeAreaView`

Always import from `'react-native-safe-area-context'`, not from `'react-native'`. The built-in version is iOS-only and effectively deprecated for cross-platform work. If reviewing code that imports `SafeAreaView` from `react-native`, flag it.

---

## `useSafeAreaInsets()`

Returns the raw inset values. Slightly slower than `SafeAreaView` during rotation (the values come through the JS bridge), but more flexible.

```tsx
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function Header() {
  const insets = useSafeAreaInsets();
  return <View style={{ paddingTop: insets.top }} />;
}
```

### `EdgeInsets` shape

```ts
{
  top: number;
  right: number;
  bottom: number;
  left: number;
}
```

All values are in DIPs (density-independent pixels), the same unit React Native styles use.

### `SafeAreaInsetsContext.Consumer`

Render-prop equivalent — useful in class components or when the hook is awkward:

```tsx
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

function Component() {
  return (
    <SafeAreaInsetsContext.Consumer>
      {(insets) => <View style={{ paddingTop: insets.top }} />}
    </SafeAreaInsetsContext.Consumer>
  );
}
```

---

## `SafeAreaView` vs `useSafeAreaInsets`

Reach for `SafeAreaView` first. It's implemented natively, so on rotation there's no async-bridge delay between the device reporting new insets and the layout updating. Use `useSafeAreaInsets` when you need the values for something other than uniform padding — e.g., applying `marginTop`, sizing an absolutely positioned element, or making layout decisions based on whether `insets.bottom > 0` (a quick proxy for "device has a home indicator").

---

## Migrating from CSS `env(safe-area-inset-*)`

In a web-only app, safe area insets came from CSS environment variables:

```css
div {
  padding-top: env(safe-area-inset-top);
  padding-left: env(safe-area-inset-left);
  padding-bottom: env(safe-area-inset-bottom);
  padding-right: env(safe-area-inset-right);
}
```

The universal equivalent is `useSafeAreaInsets`:

```tsx
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function App() {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingBottom: insets.bottom,
        paddingRight: insets.right,
      }}
    />
  );
}
```

---

## Common pitfalls

- **Hook returns all zeros** — `SafeAreaProvider` is missing or the component rendered above it. Move the provider higher in the tree.
- **Modals show content under the notch** — the modal's contents are rendered outside the main provider's tree. Wrap the modal contents in their own `SafeAreaProvider`, or use `SafeAreaView` inside the modal.
- **Importing the wrong `SafeAreaView`** — `react-native`'s built-in version is iOS-only. Always import from `react-native-safe-area-context`.
- **Double padding** — applying `SafeAreaView` _and_ `useSafeAreaInsets` padding to the same container. Pick one.
- **Bottom inset doubling with a tab bar** — if a screen sits inside a Bottom Tab Navigator that already accounts for the home indicator, the screen shouldn't pad the bottom too. Use `edges={['top', 'left', 'right']}` on `SafeAreaView`.
- **Web SSR flicker** — pass `initialSafeAreaInsets` to avoid async measurement gating first paint.

---

## Quick imports reference

```tsx
import {
  SafeAreaView,
  SafeAreaProvider,
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
```

---

## Resources

- Expo SDK page: https://docs.expo.dev/versions/latest/sdk/safe-area-context/
- Library docs: https://appandflow.github.io/react-native-safe-area-context/
- Source: https://github.com/AppAndFlow/react-native-safe-area-context
