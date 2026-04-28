# FlashList Hooks Reference

FlashList ships four hooks that solve problems specific to its recycling architecture. Use them in components rendered inside `renderItem` (or anywhere downstream of a `<FlashList>`).

The big picture: because items are **recycled** (the same component instance gets reassigned to a different data item as the user scrolls), normal `useState` carries stale state across items. These hooks fix that and a few related issues.

## `useRecyclingState`

The most important hook. Use it instead of `useState` for any per-item state that should reset when the underlying item changes.

```tsx
const [state, setState] = useRecyclingState(
  initialState,
  dependencies,   // e.g. [item.id]
  resetCallback?  // optional; runs when deps change
);
```

When the deps array changes (because the cell got reassigned to a new item), state resets to `initialState` and `resetCallback` fires — without you needing to issue a manual `setState`. It also has the layout-tracking behavior of `useLayoutState` baked in, so size changes are reported to FlashList.

```tsx
import { useRecyclingState } from '@shopify/flash-list';

function GridCard({ item }) {
  const [expanded, setExpanded] = useRecyclingState(false, [item.id], () => {
    // optional: reset scroll position of a nested ScrollView, clear timers, etc.
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

**Common reset callback uses:** clearing timers, scrolling nested horizontal lists back to the start, canceling in-flight image loads.

## `useLayoutState`

A drop-in replacement for `useState` that **also tells FlashList the item's size may have changed**. Use this when an item resizes itself based on internal state (expand/collapse, "show more" toggle, etc.) and you want the surrounding items to reflow smoothly.

```tsx
const [state, setState] = useLayoutState(initialState);
```

Without `useLayoutState`, FlashList still picks up size changes via `onLayout`, but the reflow is rougher visually. With it, the list knows about the change at state-set time and lays out cleanly.

```tsx
import { useLayoutState } from '@shopify/flash-list';

function ExpandableRow({ item }) {
  const [expanded, setExpanded] = useLayoutState(false);

  return (
    <Pressable onPress={() => setExpanded(!expanded)}>
      <View style={{ height: expanded ? 150 : 80, padding: 16 }}>
        <Text>{item.title}</Text>
      </View>
    </Pressable>
  );
}
```

**When to pick which:** if state should reset across recycling, use `useRecyclingState`. If it shouldn't (or you don't care), `useLayoutState` is fine. `useRecyclingState` already includes `useLayoutState`'s behavior, so reach for it as the default for resizable items.

## `useMappingHelper`

Solves a subtle key problem: when you do `.map()` inside an item to render sub-rows, naive `key={item.id}` props can collide with FlashList's recycling system and cause perf issues or visual glitches.

```tsx
const { getMappingKey } = useMappingHelper();

// getMappingKey(itemKey, index)
```

Always pass a stable `itemKey` (string/number/bigint) plus the loop `index`. The hook returns a key that's safe for both React reconciliation and FlashList's recycler.

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

**Use it whenever** you `.map()` to render multiple components inside a FlashList item, especially for nested lists, tag chips, or comment threads. Don't use it for arrays you're passing as `data` to another `<FlashList>` — those use `keyExtractor` instead.

## `useFlashListContext`

Gives child components access to the FlashList instance and its underlying ScrollView without prop-drilling a ref.

```tsx
const ctx = useFlashListContext();
// ctx.scrollViewRef, etc.
```

Useful inside deeply nested item components or inside a custom `CellRendererComponent` when you need to call methods like `scrollToIndex` or read the scroll position. Prefer this over passing refs through props.

## Decision quick reference

| Situation                                                      | Hook                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Item has internal state that must reset when item data changes | `useRecyclingState`                                  |
| Item resizes itself, state need not reset                      | `useLayoutState`                                     |
| `.map()` inside an item rendering multiple children            | `useMappingHelper`                                   |
| Child component needs the FlashList ref                        | `useFlashListContext`                                |
| Truly global item-independent state (theme, user prefs)        | Plain `useState` / context — recycling doesn't apply |
