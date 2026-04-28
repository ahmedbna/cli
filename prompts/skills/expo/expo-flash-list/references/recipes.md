# FlashList Recipes

Worked patterns for the most common things people build with FlashList. Each one assumes you've already done `npx expo install @shopify/flash-list`.

## Basic vertical list

```tsx
import { FlashList } from '@shopify/flash-list';
import { Text } from 'react-native';

const DATA = [
  { id: '1', title: 'First Item' },
  { id: '2', title: 'Second Item' },
];

export function MyList() {
  return (
    <FlashList
      data={DATA}
      renderItem={({ item }) => <Text>{item.title}</Text>}
      keyExtractor={(item) => item.id}
    />
  );
}
```

## Heterogeneous list (different row types)

When rows look very different (header rows, regular rows, ad rows), tag them with `getItemType` so each type recycles into its own pool.

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

Without `getItemType`, FlashList tries to recycle a "header" instance into a "post" slot, which forces re-mount and wastes the optimization.

## Memoizing `renderItem` and `extraData`

A frequent perf trap. Inline definitions break memoization.

```tsx
function Feed({ posts, selectedId, onSelect }) {
  const renderItem = useCallback(
    ({ item }: { item: Post }) => (
      <PostRow item={item} selectedId={selectedId} onPress={onSelect} />
    ),
    [selectedId, onSelect],
  );

  // primitive: no memo needed; object: useMemo
  const extraData = selectedId;

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

Inside `PostRow`, wrap with `React.memo` so it only re-renders when its props actually change.

## Per-item state that resets correctly

Plain `useState` leaks across recycled cells. Use `useRecyclingState` keyed on the item id.

```tsx
import { useRecyclingState } from '@shopify/flash-list';

function ExpandableRow({ item }) {
  const [open, setOpen] = useRecyclingState(false, [item.id]);

  return (
    <Pressable onPress={() => setOpen(!open)}>
      <View style={{ height: open ? 160 : 60 }}>
        <Text>{item.title}</Text>
        {open && <Text>{item.body}</Text>}
      </View>
    </Pressable>
  );
}
```

## Chat interface (newest at bottom)

**Don't use `inverted` for this.** Use `maintainVisibleContentPosition.startRenderingFromBottom`.

```tsx
<FlashList
  data={messages}
  keyExtractor={(m) => m.id}
  renderItem={({ item }) => <ChatBubble message={item} />}
  maintainVisibleContentPosition={{
    startRenderingFromBottom: true,
    autoscrollToBottomThreshold: 0.2, // auto-stick to bottom when near it
    animateAutoScrollToBottom: true,
  }}
  onStartReached={loadOlderMessages}
  onStartReachedThreshold={0.1}
/>
```

`onStartReached` fires when the user scrolls up near the start of the loaded data — the right place to fetch older messages. The `maintainVisibleContentPosition` defaults keep the user's position stable when older messages are prepended.

## Pull to refresh

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

If a fixed header sits above the list, pass `progressViewOffset` so the spinner clears it.

## Infinite scroll (load more on scroll-to-end)

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

Guard against re-entrancy with the `loadingMore` flag — `onEndReached` can fire repeatedly if you don't.

## Sticky section headers

```tsx
// data is flattened with section headers interspersed:
// [header, item, item, item, header, item, item, ...]
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
  stickyHeaderConfig={{
    offset: 0,
    hideRelatedCell: true,
  }}
/>;
```

Reading `target === "StickyHeader"` in `renderItem` lets the same header render differently when stuck (e.g. solid background instead of transparent).

## Masonry grid

Pinterest-style layout with varying heights:

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

To make some items span more than one column:

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

`optimizeItemArrangement` defaults to `true`, which reorders items to balance column heights. Set it to `false` if order must be preserved.

## Layout animations on insert/delete

```tsx
import { LayoutAnimation } from 'react-native';

const listRef = useRef<FlashList<Item>>(null);

const removeItem = (id: string) => {
  // 1. Prepare FIRST.
  listRef.current?.prepareForLayoutAnimationRender();
  // 2. Configure animation.
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  // 3. Mutate state.
  setData((prev) => prev.filter((it) => it.id !== id));
};

<FlashList
  ref={listRef}
  data={data}
  keyExtractor={(it) => it.id}
  renderItem={({ item }) => (
    <Pressable onPress={() => removeItem(item.id)}>
      <Text>{item.title}</Text>
    </Pressable>
  )}
/>;
```

Order matters: `prepareForLayoutAnimationRender` → `configureNext` → state update. `keyExtractor` must be set. Layout animations are experimental on Android.

## Programmatic scroll

```tsx
const listRef = useRef<FlashList<Item>>(null);

// Scroll a specific index to the center of the viewport:
listRef.current?.scrollToIndex({
  index: 42,
  viewPosition: 0.5,
  animated: true,
});

// Scroll to bottom on a button press:
listRef.current?.scrollToEnd({ animated: true });
```

## Animating cells with Reanimated

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

Always spread `props` onto the returned `CellContainer` — they include the absolute positioning that makes recycling work.
