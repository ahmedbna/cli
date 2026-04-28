# FlashList Props Reference

Complete reference for `<FlashList>` props in v2. Required props are marked. All others are optional.

## Required props

### `renderItem` _(required)_

```ts
renderItem: ({ item, index, target, extraData }) => ReactNode;
```

Renders a single item. The `target` field tells you why FlashList is rendering this item:

- `"Cell"` — normal visible row. The common case.
- `"Measurement"` — invisible measurement render. Skip analytics events here.
- `"StickyHeader"` — being shown as a sticky header. Use this to alter appearance when the item is stuck.

`extraData` mirrors the prop of the same name and is the supported way to pass external state into items without breaking memoization.

### `data` _(required)_

```ts
data: ItemT[];
```

Plain array. No need for keyed objects.

## Layout & sizing

### `horizontal`

`boolean`. Lays items out left-to-right instead of top-to-bottom. Default `false`.

### `numColumns`

`number`. Multi-column grid. Only valid when `horizontal={false}`. Items zig-zag like `flexWrap`. All items must be the same height in non-masonry mode — for varying heights use `masonry`.

### `masonry`

`boolean`. Pinterest-style grid where columns advance independently. Combine with `numColumns > 1`. See [recipes.md](recipes.md#masonry-grid).

### `optimizeItemArrangement`

`boolean`. With `masonry`, lets FlashList reorder items across columns to balance column heights. Default `true`. Turn off if item order must be preserved exactly.

### `inverted`

`boolean`. Flips the list. iOS/web use `scaleY(-1)`; Android uses `rotate(180deg)` for performance, which causes the scrollbar to appear on the **left** side. For chat UIs, prefer `maintainVisibleContentPosition.startRenderingFromBottom` instead — see [recipes.md](recipes.md#chat-interface).

### `contentContainerStyle`

```ts
contentContainerStyle?: {
  backgroundColor?, padding?, paddingTop?, paddingBottom?,
  paddingLeft?, paddingRight?, paddingVertical?, paddingHorizontal?
}
```

Padding the **content**, not the outer container. Use this for leading/trailing space around items. Only the listed style keys are accepted.

### `style`

`StyleProp<ViewStyle>`. Style for the outer container. **Do not put padding here** — FlashList assumes the outer container and ScrollView are the same size, and padding breaks that assumption. Use `contentContainerStyle` instead.

### `drawDistance`

`number` (dp/px). How far ahead of the visible area to render. Default is sensible; only tune if you have profiling evidence.

### `maxItemsInRecyclePool`

`number`. Cap on how many off-screen item instances are kept around for reuse. Default is unlimited. Setting to `0` disables recycling entirely (items unmount when they leave the screen) — useful as a debugging tool to prove a bug is recycling-related, but you'll lose the perf benefit.

## Item identity & types

### `keyExtractor`

```ts
keyExtractor?: (item, index) => string;
```

**Strongly recommended.** Without it, scrolling upward through items whose layout changed can glitch. Required if you're doing layout animations.

### `getItemType`

```ts
getItemType?: (item, index, extraData?) => string | number | undefined;
```

Returns a type tag per item. Items only recycle within their type, so heterogeneous lists (header + row + ad) recycle correctly when you tag them. Return `undefined` to use the default type (0). **Called very frequently — keep it cheap.**

### `extraData`

`any`. Marker telling the list to re-render when something outside `data` changes (selection, theme, etc.). **Memoize this.** Inline objects re-trigger renders constantly.

### `overrideItemLayout`

```ts
overrideItemLayout?: (
  layout: { span?: number },
  item, index, maxColumns, extraData?
) => void;
```

Mutate `layout.span` to make an item wider in grid/masonry layouts. **Only `span` is read in v2** — size estimates are gone. Called very frequently; keep it cheap.

## Headers, footers, separators, empty state

| Prop                       | Type                 | Purpose                                                                        |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `ListHeaderComponent`      | Component or element | Top of the list                                                                |
| `ListHeaderComponentStyle` | `ViewStyle`          | Style for header's wrapper view                                                |
| `ListFooterComponent`      | Component or element | Bottom of the list                                                             |
| `ListFooterComponentStyle` | `ViewStyle`          | Style for footer's wrapper view                                                |
| `ItemSeparatorComponent`   | Component            | Between items (not at edges). Receives `leadingItem` and `trailingItem` props. |
| `ListEmptyComponent`       | Component or element | Shown when `data` is empty                                                     |
| `ListEmptyComponentStyle`  | `ViewStyle`          | Style for empty state wrapper                                                  |

## Initial scroll

### `initialScrollIndex`

`number`. Start scrolled to this index instead of position 0.

### `initialScrollIndexParams`

`{ viewOffset?: number }`. Adjusts where the initial item lands on screen. Ignored unless `initialScrollIndex` is set.

## Sticky headers

### `stickyHeaderIndices`

`number[]`. Indices in `data` whose items should stick to the top as they scroll past.

### `stickyHeaderConfig`

```ts
{
  useNativeDriver?: boolean;     // default true
  offset?: number;               // pixels from top where headers stick; default 0
  backdropComponent?: Component; // rendered behind the sticky header
  hideRelatedCell?: boolean;     // hide the original cell while it's stuck; default false
}
```

Use `offset` when there's a fixed app header above the list. `backdropComponent` is good for blur effects.

### `onChangeStickyIndex`

```ts
(current: number, previous: number) => void;
```

Fires when which header is currently stuck changes. Useful for syncing a section indicator.

## Pagination & infinite scroll

### `onEndReached`

`() => void`. Fires once when the user nears the bottom.

### `onEndReachedThreshold`

`number` in units of visible list length. `0.5` = trigger when within half a screen of the end.

### `onStartReached`

`() => void`. Mirror of `onEndReached` for the top — useful for chat history loading.

### `onStartReachedThreshold`

`number`. Same units as `onEndReachedThreshold`, for the top.

### `maintainVisibleContentPosition`

```ts
{
  disabled?: boolean;
  autoscrollToTopThreshold?: number;
  autoscrollToBottomThreshold?: number;
  animateAutoScrollToBottom?: boolean;  // default true
  startRenderingFromBottom?: boolean;
}
```

Enabled by default to reduce glitches when content shifts. The two threshold props let you auto-scroll when content is added near an edge. `startRenderingFromBottom` is the right way to build chat UIs (newest at bottom, no `inverted` hacks). See [recipes.md](recipes.md#chat-interface).

## Pull to refresh

### `refreshing`

`boolean`. Whether the refresh spinner should be visible.

### `onRefresh`

`() => void`. Adds a default `RefreshControl`. Pair with `refreshing`.

### `refreshControl`

`ReactElement`. Custom `<RefreshControl>` — overrides the default and ignores `onRefresh`/`refreshing`. Vertical lists only.

### `progressViewOffset`

`number`. Push the spinner down when there's a fixed header above the list.

## Viewability tracking

### `viewabilityConfig`

```ts
{
  minimumViewTime: number;
  viewAreaCoveragePercentThreshold: number;
  itemVisiblePercentThreshold: number;
  waitForInteraction: boolean;
}
```

- `minimumViewTime` (ms) — item must be visible at least this long before counting. Default 250. Don't go much lower for perf reasons.
- `viewAreaCoveragePercentThreshold` (0–100) — what fraction of the viewport the item must cover.
- `itemVisiblePercentThreshold` (0–100) — what fraction of the item must be visible. Pick one of these two thresholds, not both conceptually.
- `waitForInteraction` — nothing counts as viewable until the user scrolls or you call `recordInteraction()`.

**Cannot be changed at runtime** — set it once.

### `onViewableItemsChanged`

```ts
(info: {
  viewableItems: ViewToken[];
  changed: ViewToken[];
}) => void
```

Each `ViewToken` has `index`, `isViewable`, `item`, `key`, `timestamp`. Filter on `isViewable` to separate items entering vs leaving viewability.

### `viewabilityConfigCallbackPairs`

Array of `{ viewabilityConfig, onViewableItemsChanged }` pairs. Use this when you need multiple thresholds (e.g. "any pixel visible" and "50% visible") tracked independently.

## Lifecycle callbacks

### `onLoad`

`(info: { elapsedTimeInMs: number }) => void`. Fires once after the first paint. Doesn't fire if `ListEmptyComponent` is rendered. Good for performance telemetry.

### `onCommitLayoutEffect`

`() => void`. Runs before layout is committed. Useful for measuring before paint. **Don't call `setState` inside it** — infinite loop risk. Memoize all FlashList props.

### `onBlankArea`

```ts
(e: {
  offsetStart: number;  // visible blank at top (>0 means blank visible)
  offsetEnd: number;    // visible blank at bottom (>0 means blank visible)
  blankArea: number;    // max of the two; can go negative if items render outside view
}) => void;
```

Native-side measurement of unfilled scroll area. Fires even when the list legitimately doesn't fill the screen, so check whether `data.length` is small before sounding alarms.

## Escape hatches

### `CellRendererComponent`

Custom wrapper around each cell. The root must be a `CellContainer` and you must spread the `props` you receive (they include `onLayout`, absolute positioning style, etc.). Common use: wrap with `Animated.createAnimatedComponent(CellContainer)` for Reanimated-driven cell animations.

### `renderScrollComponent`

`ComponentType<ScrollViewProps>`. Replace the underlying ScrollView (e.g. with a Reanimated or gesture-handler scroll view).

### `overrideProps`

`object`. Spread onto the internal ScrollView **last**, so it wins over everything. Example: `overrideProps={{ style: { overflow: "visible" } }}`. Use cautiously — wrong props here can break recycling.

## ScrollView props

FlashList passes through standard `ScrollView` props (`onScroll`, `scrollEventThrottle`, `showsVerticalScrollIndicator`, etc.). See [React Native's ScrollView docs](https://reactnative.dev/docs/scrollview).
