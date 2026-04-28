---
name: expo-mesh-gradient
description: Reference and usage guide for `expo-mesh-gradient`, the Expo module that exposes SwiftUI's `MeshGradient` view to React Native. Use this skill whenever the user wants to render a 2D mesh gradient, multi-point gradient, or grid-based color blend in an Expo / React Native app — including phrases like "mesh gradient", "MeshGradientView", "multi-point gradient", "SwiftUI mesh", "import expo-mesh-gradient", or any work involving the `MeshGradientView` component or the `expo-mesh-gradient` package. Also use this whenever the user asks for the kind of organic, blob-like, multi-color background popularized by iOS 18 / SwiftUI.
---

# Expo MeshGradient

`expo-mesh-gradient` exposes SwiftUI's `MeshGradient` view to React Native via the `<MeshGradientView>` component. Unlike a linear gradient (which transitions along one axis), a mesh gradient places colors at points on a 2D grid and smoothly blends between them, producing the organic multi-color "blob" backgrounds popularized by iOS 18 and SwiftUI.

Supported platforms: Android, iOS, tvOS. Included in Expo Go.

Use this skill any time the user is working with `<MeshGradientView>` or asks for a 2D / grid / multi-point gradient.

## Installation

Install via the Expo CLI so the version matches the user's SDK:

```sh
npx expo install expo-mesh-gradient
```

If installing into a bare React Native app, ensure `expo` is installed and Expo Modules are configured.

## Import

```tsx
import { MeshGradientView } from 'expo-mesh-gradient';
```

## Core mental model

A mesh gradient is defined by a **grid** of vertices. You tell it:

1. How many `columns` and `rows` of vertices the grid has.
2. Where each vertex sits in the view (`points`, normalized to `[0, 1]`).
3. What color each vertex is (`colors`).

The system then smoothly interpolates colors across the grid surface.

Both `colors` and `points` must contain exactly `columns * rows` elements, ordered row-by-row from top-left. A 3×3 mesh therefore needs 9 colors and 9 points.

## Required structural props

### `columns` and `rows`

- `columns` — number of vertices per row (default `0`)
- `rows` — number of vertices per column (default `0`)

The minimum useful mesh is 2×2 (the four corners). 3×3 and above let you place interior vertices that bend the gradient into curved, organic shapes. Higher counts give finer control but cost more to render.

### `points`

A `number[][]` of `[x, y]` coordinates, each in `[0, 1]`, listing the position of every vertex in row-major order (top row left-to-right, then next row, etc.).

For a uniform grid, the corners and midpoints fall at multiples of `1 / (columns - 1)` and `1 / (rows - 1)`. Moving interior points off the uniform grid is what creates the characteristic warped, blob-like look.

### `colors`

A `ColorValue[]` (any color format React Native accepts) with one color per vertex, in the same row-major order as `points`. Default `[]`, but in practice you must supply `columns * rows` colors for the gradient to be visible.

## Optional props

- **`smoothsColors`** (default `true`) — when `true`, uses cubic interpolation between colors for a softer blend. Set to `false` for sharper transitions (more like a low-poly look). Supported on Android, iOS, tvOS.
- **`mask`** (iOS, default `false`) — masks the gradient using the alpha channel of the children views, so the gradient appears only where the children are opaque. Useful for gradient-filled text or icons. **Note:** when `mask` is `true`, all touch / gesture interactions on the children are ignored.
- **`ignoresSafeArea`** (iOS, default `true`) — when `true`, the view extends under safe areas (notch, home indicator). Set to `false` if you want it to respect them.
- **`resolution`** (Android only) — `{ x: number, y: number }` controlling how many points are sampled along the path between vertices. Higher values give smoother curves at higher cost.
- All standard [`ViewProps`](https://reactnative.dev/docs/view#props) are supported.

## Canonical example

The example from the Expo docs — a uniform 3×3 mesh with 9 colors:

```tsx
import { MeshGradientView } from 'expo-mesh-gradient';

function App() {
  return (
    <MeshGradientView
      style={{ flex: 1 }}
      columns={3}
      rows={3}
      colors={[
        'red',
        'purple',
        'indigo',
        'orange',
        'white',
        'blue',
        'yellow',
        'green',
        'cyan',
      ]}
      points={[
        [0.0, 0.0],
        [0.5, 0.0],
        [1.0, 0.0],
        [0.0, 0.5],
        [0.5, 0.5],
        [1.0, 0.5],
        [0.0, 1.0],
        [0.5, 1.0],
        [1.0, 1.0],
      ]}
    />
  );
}
```

## Building a mesh: practical guidance

### Choose a grid size

- **2×2 (4 vertices)** — basically a 4-corner gradient; simpler than a `LinearGradient` for diagonal blends but limited.
- **3×3 (9 vertices)** — the sweet spot. The center vertex lets you push the gradient inward/outward to create curvy blobs.
- **4×4 or larger** — for very organic, multi-blob effects. Costs more.

### Start uniform, then warp

A reliable workflow:

1. Lay out points on a uniform grid (multiples of `1 / (columns - 1)` and `1 / (rows - 1)`).
2. Pick a palette and assign one color per vertex.
3. Nudge **interior** points (not the corners) off the uniform grid by ±0.1–0.2 to bend the color regions. Keep the four corners at `(0,0)`, `(1,0)`, `(0,1)`, `(1,1)` so the mesh fills the whole view.

### Order matters

Both arrays are row-major, top-to-bottom. Mismatching the order of `points` and `colors` is the most common source of unexpected output — when the result looks wrong, check this first.

### Animation

The component re-renders when `points` or `colors` change, so the typical SwiftUI trick of animating mesh points works here too: hold the points/colors in state and update them with `useEffect` + a timer, or via Reanimated shared values. Be aware that frequent re-renders of large meshes can be expensive — keep grid sizes modest if animating.

## Constraints and pitfalls

- `points.length` and `colors.length` **must** equal `columns * rows`. Mismatches will render incorrectly or not at all.
- `x` and `y` in `points` are normalized to `[0, 1]`, not pixels.
- `mask` is iOS-only and disables interaction on children — don't reach for it as a generic clipping primitive.
- `ignoresSafeArea` and `resolution` are platform-specific; don't rely on them on platforms where they aren't supported.
- This is a SwiftUI bridge on iOS. SwiftUI's `MeshGradient` requires iOS 18+, so on older iOS versions the view may not render as expected. If the user reports a blank view on an older device, that's the likely cause.

## When to use this vs. `expo-linear-gradient`

- **Linear gradient** — one-axis transition (top-to-bottom, left-to-right, diagonal). Lighter weight, web support.
- **Mesh gradient** — 2D, multi-point, organic blends. Use when the user asks for "blob" backgrounds, iOS 18-style gradients, or anything that a single-direction gradient can't express.

If the user just wants a simple two- or three-color gradient on a button or background, suggest `expo-linear-gradient` instead — it's simpler and supports the web.

## Quick checklist when writing code

- Import `MeshGradientView` from `'expo-mesh-gradient'`.
- `columns` and `rows` are both ≥ 2.
- `points.length === colors.length === columns * rows`.
- All `points` are `[x, y]` with `x, y ∈ [0, 1]`.
- The view has explicit size via `style` (e.g. `flex: 1`, `StyleSheet.absoluteFill`, or a fixed width/height).
- Platform-specific props (`mask`, `ignoresSafeArea`, `resolution`) are only set when targeting that platform, or are tolerated as no-ops elsewhere.
