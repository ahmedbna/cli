---
name: expo-linear-gradient
description: Reference and usage guide for `expo-linear-gradient`, the universal Expo component for rendering linear color gradients in React Native. Use this skill whenever the user wants to add a gradient background, gradient button, gradient overlay, fade effect, or any linear color transition in an Expo / React Native app — including phrases like "linear gradient", "gradient background", "fade overlay", "gradient button", "import LinearGradient", or any work involving the `LinearGradient` component or `expo-linear-gradient` package.
---

# Expo LinearGradient

`expo-linear-gradient` provides a universal `<LinearGradient>` React component that transitions between multiple colors in a linear direction. It works on Android, iOS, tvOS, and Web, and is included in Expo Go.

Use this skill any time the user is working with linear color gradients in an Expo / React Native project.

## Installation

Install the package using the Expo CLI (this picks the version compatible with the user's Expo SDK):

```sh
npx expo install expo-linear-gradient
```

If installing into a bare React Native app, ensure `expo` is installed and Expo Modules are configured.

## Import

```tsx
import { LinearGradient } from 'expo-linear-gradient';
```

## Core mental model

`<LinearGradient>` is a drop-in replacement for a `<View>`. It accepts all the usual `ViewProps` (`style`, `children`, layout, etc.) plus gradient-specific props:

- **`colors`** — the colors to transition through (required, at least 2)
- **`start`** / **`end`** — the direction of the gradient
- **`locations`** — where each color stop sits along the gradient
- **`dither`** (Android) — anti-banding control

Because it's just a view, you can put children inside it (text, icons, other components) to create gradient buttons, gradient cards, gradient headers, etc.

## Required prop: `colors`

`colors` is a readonly array of at least two `ColorValue` entries. Use any color format React Native accepts: hex (`'#3b5998'`), rgb/rgba (`'rgba(0,0,0,0.8)'`), or named colors.

```tsx
<LinearGradient
  colors={['#4c669f', '#3b5998', '#192f6a']}
  style={styles.button}
/>
```

For TypeScript to narrow the array to "2 or more values", declare it inline (as in the example above) or use `as const`:

```tsx
const colors = ['#4c669f', '#3b5998', '#192f6a'] as const;
```

A common pitfall: passing a single color produces a type error. For a single solid color, use `style.backgroundColor` on a regular `<View>` instead.

## Direction: `start` and `end`

`start` and `end` are points expressed as fractions of the gradient's bounding box, ranging from 0 to 1. They accept either object form `{ x, y }` or tuple form `[x, y]`.

- `{ x: 0, y: 0 }` is the top-left
- `{ x: 1, y: 0 }` is the top-right
- `{ x: 0, y: 1 }` is the bottom-left
- `{ x: 1, y: 1 }` is the bottom-right

Common directions:

```tsx
// Top → Bottom (default)
start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}

// Left → Right
start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}

// Diagonal: top-left → bottom-right
start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
```

On the web, `start` only changes the angle of the gradient — CSS gradients don't support changing the actual starting position. The same caveat applies to `end`.

## Color stops: `locations`

`locations` is an array of numbers in `[0, 1]`, the same length as `colors`, marking where each color stop sits. Values must be ascending.

```tsx
<LinearGradient
  colors={['red', 'yellow', 'blue']}
  locations={[0, 0.5, 0.8]}
  style={{ flex: 1 }}
/>
```

This renders red from 0% to 50%, transitions red → yellow from 50% to 80% (wait — re-read the docs: each location pins where that color is fully present, and the gradient transitions between adjacent stops). If `locations` is omitted, colors are distributed evenly.

## Other props

- **`dither`** (Android, default `true`) — keeps gradient banding under control. Disable it (`false`) only if you've measured a real perf win on a specific screen.
- All standard [`ViewProps`](https://reactnative.dev/docs/view#props) are supported and inherited.

## Common patterns

### Full-screen background

```tsx
<LinearGradient
  colors={['#4c669f', '#3b5998', '#192f6a']}
  style={StyleSheet.absoluteFill}
/>
```

### Fade overlay on an image

```tsx
<View style={styles.imageContainer}>
  <Image source={...} style={StyleSheet.absoluteFill} />
  <LinearGradient
    colors={['transparent', 'rgba(0,0,0,0.8)']}
    style={StyleSheet.absoluteFill}
  />
</View>
```

Use `'transparent'` (or `'rgba(...,0)'`) at one end for fade effects.

### Gradient button

```tsx
<LinearGradient
  colors={['#4c669f', '#3b5998', '#192f6a']}
  start={{ x: 0, y: 0 }}
  end={{ x: 1, y: 0 }}
  style={styles.button}
>
  <Text style={styles.text}>Sign in</Text>
</LinearGradient>
```

Wrap with `Pressable` or `TouchableOpacity` if you need touch handling — `LinearGradient` itself doesn't handle touch events specially.

### Gradient text (workaround)

`LinearGradient` cannot directly fill text on Android/iOS without masking. For gradient text, use `MaskedView` from `@react-native-masked-view/masked-view` with `LinearGradient`, or use a separate library. Don't claim `LinearGradient` alone can do gradient text fill.

## Full reference example

This is the canonical example from the Expo docs — keep it as a reference for new users:

```tsx
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export default function App() {
  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['rgba(0,0,0,0.8)', 'transparent']}
        style={styles.background}
      />
      <LinearGradient
        colors={['#4c669f', '#3b5998', '#192f6a']}
        style={styles.button}
      >
        <Text style={styles.text}>Sign in with Facebook</Text>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'orange',
  },
  background: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 300,
  },
  button: {
    padding: 15,
    alignItems: 'center',
    borderRadius: 5,
  },
  text: {
    backgroundColor: 'transparent',
    fontSize: 15,
    color: '#fff',
  },
});
```

## Alternatives

If the user only needs a simple gradient and wants to avoid an extra dependency, mention that React Native exposes `experimental_backgroundImage` (Android/iOS) and `backgroundImage` (Web) on `View`, which accept CSS gradient syntax like `linear-gradient(...)` and `radial-gradient(...)`. It's experimental, so `expo-linear-gradient` remains the more robust default.

## Quick checklist when writing code

- Import from `'expo-linear-gradient'`, not from `'react-native'` or `'react-native-linear-gradient'` (that's a different community package).
- `colors` has at least 2 entries.
- `start` / `end` use values in `[0, 1]`, not pixel values.
- `locations`, when used, has the same length as `colors` and is ascending.
- For full-screen or absolute backgrounds, give the gradient an explicit size via `style` — it doesn't auto-size to its parent unless layout is set up to do so.
