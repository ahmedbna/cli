---
name: expo-safe-area-context
description: Safe area insets in Expo/RN with `react-native-safe-area-context` — `SafeAreaView`, `useSafeAreaInsets`, and `SafeAreaProvider`. Avoid notches, status bars, home indicators.
---

# react-native-safe-area-context

Always import from `react-native-safe-area-context`, NOT `react-native` (the built-in `SafeAreaView` is iOS-only and deprecated).

## When to use what

- **`SafeAreaView`** — drop-in `View` replacement that pads itself by safe area insets. Native; no rotation jank.
- **`useSafeAreaInsets()`** — hook returning `{ top, right, bottom, left }`. Use for non-padding props (margins, absolute positioning) or conditional logic.
- **`SafeAreaInsetsContext.Consumer`** — render-prop equivalent for class components.

`SafeAreaProvider` is **required at the app root**.

Supported on Android, iOS, tvOS, Web. Included in Expo Go.

## Install

```sh
npx expo install react-native-safe-area-context
```

## Setup: `SafeAreaProvider`

```tsx
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function App() {
  return <SafeAreaProvider>{/* ...rest of app */}</SafeAreaProvider>;
}
```

Add it inside modals too — they don't always inherit the outer provider.

### Speeding up first render

```tsx
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';

<SafeAreaProvider initialMetrics={initialWindowMetrics}>
  {/* ... */}
</SafeAreaProvider>;
```

Don't use if the provider remounts mid-lifecycle or with `react-native-navigation`.

## `SafeAreaView`

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

| Prop                     | Type      | Default                              | Notes                                                              |
| ------------------------ | --------- | ------------------------------------ | ------------------------------------------------------------------ |
| `edges`                  | `Edge[]`  | `['top', 'right', 'bottom', 'left']` | Subset for partial insets, e.g. `edges={['top']}` with a tab bar.  |
| `emulateUnlessSupported` | `boolean` | `true`                               | Emulate via status bar/home indicator when native insets missing.  |

`Edge`: `'top' | 'right' | 'bottom' | 'left'`.

## `useSafeAreaInsets()`

```tsx
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function Header() {
  const insets = useSafeAreaInsets();
  return <View style={{ paddingTop: insets.top }} />;
}
```

`EdgeInsets` shape:

```ts
{ top: number; right: number; bottom: number; left: number }
```

All values in DIPs.

### `SafeAreaInsetsContext.Consumer`

```tsx
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

<SafeAreaInsetsContext.Consumer>
  {(insets) => <View style={{ paddingTop: insets.top }} />}
</SafeAreaInsetsContext.Consumer>
```

## SafeAreaView vs hook

Reach for `SafeAreaView` first (native, no rotation lag). Use `useSafeAreaInsets` when you need values for margins, absolute positioning, or conditional logic.

## Migrating from CSS `env(safe-area-inset-*)`

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

## Common pitfalls

- **Hook returns all zeros** — `SafeAreaProvider` missing or rendered above. Move it higher.
- **Modal content under the notch** — wrap modal in its own `SafeAreaProvider` or `SafeAreaView`.
- **Wrong `SafeAreaView`** — `react-native`'s is iOS-only. Always import from `react-native-safe-area-context`.
- **Double padding** — applying `SafeAreaView` _and_ `useSafeAreaInsets` padding to the same container.
- **Bottom inset doubling with tab bar** — use `edges={['top', 'left', 'right']}`.
- **Web SSR flicker** — pass `initialSafeAreaInsets`.

## Imports

```tsx
import {
  SafeAreaView,
  SafeAreaProvider,
  SafeAreaInsetsContext,
  useSafeAreaInsets,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
```
