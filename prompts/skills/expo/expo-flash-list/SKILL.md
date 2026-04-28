---
name: expo-flash-list
description: Use this skill whenever the user is building lists, feeds, grids, or chat interfaces in Expo or React Native and either mentions FlashList, @shopify/flash-list, FlatList performance issues, list recycling, or wants a "fast" or "performant" list. Also trigger when the user is migrating from FlatList to FlashList, working with masonry/grid layouts in RN, debugging list scroll performance, implementing chat-style inverted lists, or asking about list-related hooks like useRecyclingState, useLayoutState, or useMappingHelper. Covers v2 API, migration from v1 (including the removed MasonryFlashList), all props, methods, and common gotchas around recycling and key extraction.
---

# Expo FlashList (`@shopify/flash-list`)

FlashList is a drop-in replacement for React Native's `FlatList` that recycles components under the hood for better performance. It ships in Expo Go and works on Android, iOS, tvOS, and Web.

This skill covers the **v2 API**. v2 changed several things from v1 that often break naive migrations — read the migration section carefully if the user has existing FlashList code.

## Installation

```sh
npx expo install @shopify/flash-list
```

## The mental model that matters most

Two ideas drive nearly every FlashList bug:

1. **Items are recycled, not unmounted.** When an item scrolls off-screen, its component instance is reused for a different item further down. This means component state (`useState`, scroll positions in nested lists, expanded/collapsed flags) leaks between data items unless you handle it. This is the single most common source of FlashList bugs.

2. **Props must be memoized.** v2 is more aggressive about updating items than v1 was. If `renderItem`, `extraData`, or other props change identity on every parent render, child items re-render unnecessarily. Wrap callbacks in `useCallback` and objects in `useMemo`.

If a list "works but flickers" or "shows wrong data after scrolling," it's almost always one of these two.

## Minimum viable usage

```tsx
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={items}
  renderItem={({ item }) => <Row item={item} />}
  keyExtractor={(item) => item.id}
/>;
```

`keyExtractor` is technically optional but **strongly recommended in v2** — without it you'll see glitches when item layouts change as the user scrolls upward.

## Migrating from FlatList

The migration is usually trivial in syntax but has gotchas:

1. Rename `FlatList` → `FlashList`. Most props carry over.
2. **Remove explicit `key` props from inside your `renderItem` tree.** If you have `.map()` calls inside an item, use the `useMappingHelper` hook (see [references/hooks.md](references/hooks.md)) instead of `key={item.id}`.
3. **Audit `useState` inside items.** Any state that should reset when the item's data changes must use `useRecyclingState` instead of `useState`, or be keyed off the item's id.
4. Pass `getItemType` if the list has visually different row types (e.g. headers + rows + ads). This lets FlashList recycle within a type rather than across types.
5. **Test performance in release mode only.** Dev mode uses a small render buffer and feels slower than reality.
6. Do not port these FlatList props — they're either unsupported or no-ops in FlashList: `getItemLayout`, `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`, `disableVirtualization`, `onScrollToIndexFailed`, `columnWrapperStyle`, `listKey`, `debug`.

## When to read which reference

The full API is large. Load only what's relevant to the current task:

- **[references/props.md](references/props.md)** — Every prop with type signatures and notes. Read when the user asks about a specific prop, or when you need to construct a non-trivial FlashList.
- **[references/hooks.md](references/hooks.md)** — `useRecyclingState`, `useLayoutState`, `useMappingHelper`, `useFlashListContext`. Read when the user is building item components with internal state, dynamic heights, or nested mapped content.
- **[references/methods.md](references/methods.md)** — Imperative methods on the FlashList ref (`scrollToIndex`, `prepareForLayoutAnimationRender`, etc.). Read when the user wants programmatic scroll control or layout animations.
- **[references/recipes.md](references/recipes.md)** — Worked examples for chat (inverted/`maintainVisibleContentPosition`), masonry grids, sticky headers, layout animations, and pull-to-refresh.

## Common gotchas to watch for

When writing FlashList code, proactively check for these — they cause a disproportionate share of bugs:

- **Inline arrow functions for `renderItem`** defeat memoization. Define `renderItem` with `useCallback`, or hoist it.
- **Inline object literals in `extraData`** (`extraData={{ selectedId }}`) cause every item to re-render every parent render. Use `useMemo` or pass a stable primitive.
- **Padding on the `style` prop** changes the ScrollView size assumption and breaks layout. Use `contentContainerStyle` instead.
- **Nested horizontal FlashList inside a vertical ScrollView** loses optimizations. The outer list should also be a FlashList when possible.
- **Chat interfaces using `inverted`** — prefer `maintainVisibleContentPosition.startRenderingFromBottom` instead. `inverted` uses CSS transforms that have quirks (left-side scrollbar on Android, gesture/accessibility issues).
- **Calling `prepareForLayoutAnimationRender()` after `LayoutAnimation.configureNext`** — the order is reversed. `prepareForLayoutAnimationRender` must come **first**.

## Unsupported FlatList props (don't suggest these)

These FlatList props are not implemented and won't be: `columnWrapperStyle`, `debug`, `listKey`, `disableVirtualization`, `getItemLayout`, `initialNumToRender`, `maxToRenderPerBatch`, `setNativeProps`, `updateCellsBatchingPeriod`, `onScrollToIndexFailed`, `windowSize`. If the user asks for one of these, suggest the FlashList equivalent if there is one, or explain that the underlying recycling architecture makes it unnecessary.

## Reporting doc issues

If something in this skill is wrong or stale, the user can report it via:

```bash
curl -X POST https://api.expo.dev/v2/feedback/docs-send \
  -H 'Content-Type: application/json' \
  -d '{"url":"/versions/latest/sdk/flash-list/","feedback":"<specific actionable issue>"}'
```

Only submit specific, actionable feedback — not general impressions.
