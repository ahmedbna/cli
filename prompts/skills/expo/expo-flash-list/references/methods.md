# FlashList Imperative Methods

Methods called on a `FlashList` ref. Get the ref the usual way:

```tsx
const listRef = useRef<FlashList<ItemT>>(null);

<FlashList ref={listRef} ... />

listRef.current?.scrollToIndex({ index: 10, animated: true });
```

## Scrolling

### `scrollToIndex(params)`

```ts
scrollToIndex(params: {
  index: number;
  animated?: boolean;
  viewOffset?: number;   // pixels from the top edge
  viewPosition?: number; // 0 = top, 0.5 = center, 1 = bottom
}): void
```

Scroll to a specific item by index. `viewPosition` controls where the item lands within the viewport.

### `scrollToItem(params)`

```ts
scrollToItem(params: {
  item: any;
  animated?: boolean;
  viewPosition?: number;
}): void
```

Same as `scrollToIndex` but you pass the item itself. FlashList finds its index for you. Slower than `scrollToIndex` for large lists.

### `scrollToOffset(params)`

```ts
scrollToOffset(params: {
  offset: number;
  animated?: boolean;
}): void
```

Scroll to an exact pixel offset. `offset` is the y-value for vertical lists, x-value for horizontal.

### `scrollToEnd(params?)`

```ts
scrollToEnd(params?: { animated?: boolean }): void
```

Scroll to the very bottom (or right, if horizontal).

### `scrollToTop(params?)`

```ts
scrollToTop(params?: { animated?: boolean }): void
```

Scroll to position 0.

## Layout animations

### `prepareForLayoutAnimationRender()`

```ts
prepareForLayoutAnimationRender(): void
```

**Call this before `LayoutAnimation.configureNext()`.** It temporarily disables recycling for the next frame so layout animations look right. The next render after the animation re-enables recycling automatically.

```tsx
listRef.current?.prepareForLayoutAnimationRender();
LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
setData(newData);
```

**Caveat:** because recycling is disabled briefly, large data changes (e.g. replacing the whole list) under layout animations can cause FlashList to render a lot at once. Restrict layout animations to small changes — single insertions/deletions are fine.

`keyExtractor` must be set for layout animations to track items correctly.

## Viewability

### `recordInteraction()`

```ts
recordInteraction(): void
```

Tells the list a user interaction happened. Only matters when `viewabilityConfig.waitForInteraction` is `true` — you'd call this on a tap or navigation event so viewability tracking starts even if the user hasn't scrolled yet.

### `recomputeViewableItems()`

```ts
recomputeViewableItems(): void
```

Manually re-trigger viewability calculations. Useful when something off-screen changed and you want viewability callbacks to fire without scrolling.

## Visibility queries

### `getVisibleIndices()`

```ts
getVisibleIndices(): number[]
```

Currently visible item indices.

### `getFirstVisibleIndex()`

```ts
getFirstVisibleIndex(): number
```

Convenience for the topmost visible index.

### `getLayout()`

```ts
getLayout(): { x: number; y: number; width: number; height: number }
```

Current bounds of the list itself.

### `getWindowSize()`

```ts
getWindowSize(): { width: number; height: number }
```

Rendered dimensions of the visible window.

### `getFirstItemOffset()`

```ts
getFirstItemOffset(): number
```

Pixel offset of the first item from the start of the scrollable content. Equal to header size + top padding. Useful for syncing parallax or sticky UI above the list.

## Underlying ScrollView access

### `getNativeScrollRef()`

```ts
getNativeScrollRef(): RefObject<CompatScroller>
```

Ref to the actual scroll view. Use when you need to interop with libraries that take a scroll ref directly (e.g. `react-native-reanimated` `useAnimatedScrollHandler`, gesture handler).

### `getScrollResponder()`

```ts
getScrollResponder(): any
```

Older RN scroll responder API. Rarely needed.

### `getScrollableNode()`

```ts
getScrollableNode(): any
```

The native scrollable node. Used by some animation libraries.

## Misc

### `flashScrollIndicators()`

```ts
flashScrollIndicators(): void
```

Briefly show the scroll indicators. Good as a hint that the list is scrollable when content first appears.
