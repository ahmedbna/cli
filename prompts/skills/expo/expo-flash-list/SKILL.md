---
name: expo-flash-list
description: Performant lists/grids/feeds with `@shopify/flash-list` v2 — recycling, masonry, chat patterns, and migration from FlatList.
---

# Expo FlashList (`@shopify/flash-list`)

Drop-in replacement for `FlatList` with component recycling. Ships in Expo Go.

## Install

```sh
npx expo install @shopify/flash-list
```

## Mental model — two ideas drive nearly every bug

1. **Items are recycled, not unmounted.** Component instances are reused. State (`useState`, scroll positions) leaks between items unless handled.
2. **Props must be memoized.** v2 is more aggressive about updating items. Wrap callbacks in `useCallback` and objects in `useMemo`.

## Minimum viable usage

```tsx
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={items}
  renderItem={({ item }) => <Row item={item} />}
  keyExtractor={(item) => item.id}
/>;
```

`keyExtractor` is technically optional but **strongly recommended in v2** — without it, scrolling upward through items whose layout changed can glitch.

## Common gotchas

- **Inline arrow functions for `renderItem`** defeat memoization. Define with `useCallback`.
- **Inline object literals in `extraData`** cause re-renders. Use `useMemo` or a primitive.
- **Padding on the `style` prop** breaks layout. Use `contentContainerStyle`.
- **Nested horizontal FlashList in vertical ScrollView** loses optimizations.
- **Chat with `inverted`** — prefer `maintainVisibleContentPosition.startRenderingFromBottom`.
- **`prepareForLayoutAnimationRender()` order** — must come **before** `LayoutAnimation.configureNext`.

---

## Hooks

### `useRecyclingState`

Most important hook. Replace `useState` for per-item state that should reset when data changes.

```tsx
const [state, setState] = useRecyclingState(
  initialState,
  dependencies,   // e.g. [item.id]
  resetCallback?  // optional; runs when deps change
);
```

```tsx
import { useRecyclingState } from '@shopify/flash-list';

function GridCard({ item }) {
  const [expanded, setExpanded] = useRecyclingState(false, [item.id], () => {
    // optional: reset scroll position, clear timers, etc.
  });

  return (
    <Pressable onPress={() => setExpanded(!expanded)}>
      <View style={{ height: expanded ? 200 : 80 }}>
        <Text>{item.title}</Text>
      </View>
    </Pressable>
  );
}
```

### `useLayoutState`

Drop-in `useState` that **also tells FlashList the item's size may have changed**.

```tsx
const [state, setState] = useLayoutState(initialState);
```

`useRecyclingState` includes this behavior. Use `useLayoutState` if state shouldn't reset on recycling.

### `useMappingHelper`

For `.map()` inside an item — naive `key={item.id}` collides with FlashList's recycling.

```tsx
import { useMappingHelper } from '@shopify/flash-list';

function CommentList({ comments }) {
  const { getMappingKey } = useMappingHelper();
  return (
    <View>
      {comments.map((c, i) => (
        <Text key={getMappingKey(c.id, i)}>{c.body}</Text>
      ))}
    </View>
  );
}
```

Don't use for arrays passed as `data` to another `<FlashList>` — those use `keyExtractor`.

### `useFlashListContext`

Access the FlashList instance and ScrollView without prop-drilling refs.

```tsx
const ctx = useFlashListContext();
// ctx.scrollViewRef, etc.
```

### Hook decision table

| Situation                                           | Hook                  |
| --------------------------------------------------- | --------------------- |
| Item state must reset when data changes             | `useRecyclingState`   |
| Item resizes, state need not reset                  | `useLayoutState`      |
| `.map()` inside an item rendering multiple children | `useMappingHelper`    |
| Child needs the FlashList ref                       | `useFlashListContext` |
| Truly global state (theme, user prefs)              | Plain `useState`      |

---

## Props reference

### Required

- **`renderItem({ item, index, target, extraData })`** — `target` is `"Cell"` (normal), `"Measurement"` (skip analytics), or `"StickyHeader"`.
- **`data: ItemT[]`** — plain array.

### Layout & sizing

- `horizontal` — left-to-right.
- `numColumns` — grid (only with `horizontal={false}`); items zig-zag.
- `masonry` — Pinterest-style; combine with `numColumns > 1`.
- `optimizeItemArrangement` (default `true`) — reorder masonry items to balance columns.
- `inverted` — flips list. **Prefer `maintainVisibleContentPosition.startRenderingFromBottom`** for chat.
- `contentContainerStyle` — only `padding*`, `backgroundColor` accepted.
- `style` — outer container; **don't put padding here**.
- `drawDistance` — render-ahead distance.
- `maxItemsInRecyclePool` — cap on off-screen instances. `0` disables recycling.

### Item identity & types

- `keyExtractor(item, index) => string` — strongly recommended.
- `getItemType(item, index, extraData?) => string | number | undefined` — items recycle within their type. **Keep cheap.**
- `extraData` — marker for re-render when external state changes. **Memoize.**
- `overrideItemLayout(layout, item, ...) => void` — mutate `layout.span` for grid/masonry. **Only `span` is read in v2.**

### Headers / footers / separators / empty

| Prop                     | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `ListHeaderComponent`    | Top of list                                           |
| `ListFooterComponent`    | Bottom of list                                        |
| `ItemSeparatorComponent` | Between items (receives `leadingItem`/`trailingItem`) |
| `ListEmptyComponent`     | Shown when `data` is empty                            |

### Initial scroll

- `initialScrollIndex` — start at this index.
- `initialScrollIndexParams: { viewOffset?: number }`.

### Sticky headers

- `stickyHeaderIndices: number[]`.
- `stickyHeaderConfig: { useNativeDriver?, offset?, backdropComponent?, hideRelatedCell? }`.
- `onChangeStickyIndex(current, previous)`.

### Pagination & infinite scroll

- `onEndReached` / `onEndReachedThreshold` — bottom.
- `onStartReached` / `onStartReachedThreshold` — top (chat history).
- `maintainVisibleContentPosition: { startRenderingFromBottom?, autoscrollToTopThreshold?, autoscrollToBottomThreshold?, animateAutoScrollToBottom? }` — enabled by default.

### Pull to refresh

- `refreshing: boolean` + `onRefresh: () => void`.
- `refreshControl` — custom `<RefreshControl>` (vertical lists only).
- `progressViewOffset` — push spinner past fixed header.

### Viewability

- `viewabilityConfig: { minimumViewTime, viewAreaCoveragePercentThreshold, itemVisiblePercentThreshold, waitForInteraction }`. **Cannot change at runtime.**
- `onViewableItemsChanged({ viewableItems, changed })`.
- `viewabilityConfigCallbackPairs` — multiple thresholds independently.

### Lifecycle callbacks

- `onLoad({ elapsedTimeInMs })` — fires once after first paint (not if `ListEmptyComponent` shown).
- `onCommitLayoutEffect` — runs before layout commits. **Don't `setState` inside.**
- `onBlankArea({ offsetStart, offsetEnd, blankArea })`.

### Escape hatches

- `CellRendererComponent` — custom wrapper. Root must be `CellContainer` and spread `props`.
- `renderScrollComponent` — replace underlying ScrollView.
- `overrideProps` — spreads onto internal ScrollView last. Use cautiously.

---

## Imperative methods (on ref)

```tsx
const listRef = useRef<FlashList<ItemT>>(null);
listRef.current?.scrollToIndex({ index: 10, animated: true });
```

### Scrolling

- `scrollToIndex({ index, animated?, viewOffset?, viewPosition? })` — `viewPosition`: 0=top, 0.5=center, 1=bottom.
- `scrollToItem({ item, animated?, viewPosition? })` — slower for large lists.
- `scrollToOffset({ offset, animated? })` — exact pixel offset.
- `scrollToEnd({ animated? })`.
- `scrollToTop({ animated? })`.

### Layout animations

- `prepareForLayoutAnimationRender()` — **call BEFORE `LayoutAnimation.configureNext()`**. `keyExtractor` required.

### Viewability

- `recordInteraction()` — for `waitForInteraction: true`.
- `recomputeViewableItems()`.

### Visibility queries

- `getVisibleIndices()`, `getFirstVisibleIndex()`.
- `getLayout() => { x, y, width, height }`.
- `getWindowSize() => { width, height }`.
- `getFirstItemOffset()` — pixel offset of first item.

### ScrollView access

- `getNativeScrollRef()` — for Reanimated `useAnimatedScrollHandler`, gesture handler.
- `getScrollResponder()`, `getScrollableNode()`.

### Misc

- `flashScrollIndicators()`.

---

## Recipes

### Heterogeneous list

```tsx
<FlashList
  data={feed}
  keyExtractor={(item) => item.id}
  getItemType={(item) => item.kind} // "header" | "post" | "ad"
  renderItem={({ item }) => {
    switch (item.kind) {
      case 'header':
        return <SectionHeader item={item} />;
      case 'post':
        return <Post item={item} />;
      case 'ad':
        return <AdSlot item={item} />;
    }
  }}
/>
```

### Memoizing renderItem and extraData

```tsx
function Feed({ posts, selectedId, onSelect }) {
  const renderItem = useCallback(
    ({ item }: { item: Post }) => (
      <PostRow item={item} selectedId={selectedId} onPress={onSelect} />
    ),
    [selectedId, onSelect],
  );

  const extraData = selectedId; // primitive: no memo needed

  return (
    <FlashList
      data={posts}
      renderItem={renderItem}
      extraData={extraData}
      keyExtractor={(p) => p.id}
    />
  );
}
```

Inside `PostRow`, wrap with `React.memo`.

### Chat (newest at bottom)

**Don't use `inverted`.** Use `maintainVisibleContentPosition.startRenderingFromBottom`.

```tsx
<FlashList
  data={messages}
  keyExtractor={(m) => m.id}
  renderItem={({ item }) => <ChatBubble message={item} />}
  maintainVisibleContentPosition={{
    startRenderingFromBottom: true,
    autoscrollToBottomThreshold: 0.2,
    animateAutoScrollToBottom: true,
  }}
  onStartReached={loadOlderMessages}
  onStartReachedThreshold={0.1}
/>
```

### Pull to refresh

```tsx
const [refreshing, setRefreshing] = useState(false);
const onRefresh = useCallback(async () => {
  setRefreshing(true);
  try {
    await refetch();
  } finally {
    setRefreshing(false);
  }
}, [refetch]);

<FlashList
  data={items}
  renderItem={renderItem}
  keyExtractor={(item) => item.id}
  refreshing={refreshing}
  onRefresh={onRefresh}
/>;
```

### Infinite scroll

```tsx
const onEndReached = useCallback(() => {
  if (!loadingMore && hasNextPage) loadMore();
}, [loadingMore, hasNextPage, loadMore]);

<FlashList
  data={items}
  renderItem={renderItem}
  keyExtractor={(item) => item.id}
  onEndReached={onEndReached}
  onEndReachedThreshold={0.5}
  ListFooterComponent={loadingMore ? <ActivityIndicator /> : null}
/>;
```

Guard with `loadingMore` flag — `onEndReached` can fire repeatedly.

### Sticky section headers

```tsx
const stickyIndices = data
  .map((d, i) => (d.type === 'header' ? i : -1))
  .filter((i) => i !== -1);

<FlashList
  data={data}
  keyExtractor={(d) => d.id}
  getItemType={(d) => d.type}
  renderItem={({ item, target }) => {
    if (item.type === 'header') {
      return <SectionHeader item={item} isSticky={target === 'StickyHeader'} />;
    }
    return <Row item={item} />;
  }}
  stickyHeaderIndices={stickyIndices}
  stickyHeaderConfig={{ offset: 0, hideRelatedCell: true }}
/>;
```

### Masonry grid

```tsx
<FlashList
  data={photos}
  masonry
  numColumns={2}
  keyExtractor={(p) => p.id}
  renderItem={({ item }) => (
    <Image
      source={{ uri: item.url }}
      style={{ aspectRatio: item.aspectRatio, margin: 4 }}
    />
  )}
/>
```

Featured items spanning columns:

```tsx
<FlashList
  data={items}
  masonry
  numColumns={3}
  keyExtractor={(i) => i.id}
  overrideItemLayout={(layout, item) => {
    layout.span = item.featured ? 2 : 1;
  }}
  renderItem={({ item }) => <Card item={item} />}
/>
```

### Layout animations on insert/delete

```tsx
import { LayoutAnimation } from 'react-native';

const listRef = useRef<FlashList<Item>>(null);

const removeItem = (id: string) => {
  // Order matters
  listRef.current?.prepareForLayoutAnimationRender();
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  setData((prev) => prev.filter((it) => it.id !== id));
};
```

`keyExtractor` required. Layout animations are experimental on Android.

### Animating cells with Reanimated

```tsx
import Animated from 'react-native-reanimated';
import { CellContainer } from '@shopify/flash-list';

const AnimatedCellContainer = Animated.createAnimatedComponent(CellContainer);

<FlashList
  data={data}
  renderItem={renderItem}
  keyExtractor={(it) => it.id}
  CellRendererComponent={(props) => (
    <AnimatedCellContainer {...props} entering={FadeIn} />
  )}
/>;
```

Always spread `props` — they include absolute positioning that makes recycling work.

## Unsupported FlatList props

`columnWrapperStyle`, `debug`, `listKey`, `disableVirtualization`, `getItemLayout`, `initialNumToRender`, `maxToRenderPerBatch`, `setNativeProps`, `updateCellsBatchingPeriod`, `onScrollToIndexFailed`, `windowSize`.
