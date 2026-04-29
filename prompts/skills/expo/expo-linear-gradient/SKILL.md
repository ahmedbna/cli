---
name: expo-linear-gradient
description: Linear color gradients with `expo-linear-gradient` — gradient backgrounds, fade overlays, and gradient buttons.
---

# Expo LinearGradient

## Install

```sh
npx expo install expo-linear-gradient
```

## Import

```tsx
import { LinearGradient } from 'expo-linear-gradient';
```

## Core mental model

`<LinearGradient>` is a drop-in replacement for `<View>` with gradient props:

- **`colors`** — colors to transition through (required, ≥2)
- **`start`** / **`end`** — direction (`{ x, y }` in `[0, 1]`)
- **`locations`** — color stop positions (same length as `colors`, ascending)
- **`dither`** (Android) — anti-banding

## Required: `colors`

```tsx
<LinearGradient
  colors={['#4c669f', '#3b5998', '#192f6a']}
  style={styles.button}
/>
```

For TypeScript narrowing, declare inline or use `as const`:

```tsx
const colors = ['#4c669f', '#3b5998', '#192f6a'] as const;
```

## Direction: `start` and `end`

Points expressed as fractions of the bounding box (`[0, 1]`):

```tsx
// Top → Bottom (default)
start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}

// Left → Right
start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}

// Diagonal
start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
```

On the web, `start` only changes the angle — CSS gradients don't support changing the actual starting position.

## Color stops: `locations`

```tsx
<LinearGradient
  colors={['red', 'yellow', 'blue']}
  locations={[0, 0.5, 0.8]}
  style={{ flex: 1 }}
/>
```

If omitted, colors are distributed evenly.

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

Wrap with `Pressable`/`TouchableOpacity` for touch handling.

### Gradient text

`LinearGradient` cannot directly fill text. Use `MaskedView` from `@react-native-masked-view/masked-view` with `LinearGradient`.

## Quick checklist

- Import from `'expo-linear-gradient'`, NOT `'react-native'` or `'react-native-linear-gradient'`.
- `colors` has at least 2 entries.
- `start`/`end` use `[0, 1]`, not pixels.
- `locations` length matches `colors`, ascending.
- Give the gradient an explicit size via `style`.
