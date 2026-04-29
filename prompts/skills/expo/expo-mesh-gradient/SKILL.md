---
name: expo-mesh-gradient
description: 2D mesh gradients (multi-point, organic blends) with `expo-mesh-gradient` — for iOS 18-style "blob" backgrounds via SwiftUI's `MeshGradient`.
---

# Expo MeshGradient

`expo-mesh-gradient` exposes SwiftUI's `MeshGradient` to React Native. Places colors at points on a 2D grid and smoothly blends between them.

Supported: Android, iOS, tvOS. Included in Expo Go.

## Install

```sh
npx expo install expo-mesh-gradient
```

## Import

```tsx
import { MeshGradientView } from 'expo-mesh-gradient';
```

## Core mental model

A grid of vertices defined by:
1. `columns` × `rows` count.
2. `points` — `[x, y]` positions in `[0, 1]`, row-major from top-left.
3. `colors` — one per vertex, same row-major order.

Both `colors` and `points` must contain exactly `columns * rows` elements.

## Required props

- **`columns`** / **`rows`** — vertex grid dimensions (≥2 useful).
- **`points`**: `number[][]` — `[x, y]` coords in `[0, 1]`, row-major.
- **`colors`**: `ColorValue[]` — one per vertex, row-major.

## Optional props

- **`smoothsColors`** (default `true`) — cubic interpolation between colors.
- **`mask`** (iOS, default `false`) — masks gradient to children's alpha. Disables touch on children.
- **`ignoresSafeArea`** (iOS, default `true`).
- **`resolution`** (Android) — `{ x, y }` for sampling smoothness.
- All standard `ViewProps`.

## Canonical example

```tsx
import { MeshGradientView } from 'expo-mesh-gradient';

function App() {
  return (
    <MeshGradientView
      style={{ flex: 1 }}
      columns={3}
      rows={3}
      colors={[
        'red', 'purple', 'indigo',
        'orange', 'white', 'blue',
        'yellow', 'green', 'cyan',
      ]}
      points={[
        [0.0, 0.0], [0.5, 0.0], [1.0, 0.0],
        [0.0, 0.5], [0.5, 0.5], [1.0, 0.5],
        [0.0, 1.0], [0.5, 1.0], [1.0, 1.0],
      ]}
    />
  );
}
```

## Building a mesh

### Choose grid size

- **2×2** — basic 4-corner gradient
- **3×3** — sweet spot. Center vertex creates curvy blobs.
- **4×4+** — multi-blob effects, more cost.

### Workflow

1. Lay out points on a uniform grid (multiples of `1 / (columns - 1)`).
2. Assign one color per vertex.
3. Nudge **interior** points (not corners) by ±0.1–0.2 to bend color regions.
4. Keep corners at `(0,0)`, `(1,0)`, `(0,1)`, `(1,1)`.

### Animation

Hold points/colors in state and update with timer or Reanimated. Frequent re-renders of large meshes are expensive — keep grid sizes modest.

## Constraints

- `points.length === colors.length === columns * rows`.
- `points` are normalized to `[0, 1]`, not pixels.
- `mask` is iOS-only and disables touch on children.
- SwiftUI `MeshGradient` requires iOS 18+ — older iOS may show blank.

## Linear vs mesh

- **Linear** — one-axis transition. Lighter, web support.
- **Mesh** — 2D, multi-point. For "blob" backgrounds, iOS 18-style.
