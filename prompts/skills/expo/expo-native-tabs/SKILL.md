---
name: expo-native-tabs
description: Use this skill whenever the user is building tab-based navigation in an Expo / Expo Router app and wants to use the platform's native system tab bar (UITabBar on iOS, Material Tabs on Android) — including liquid glass tabs on iOS 26, SF Symbol or Material Symbol icons, badges, search tabs, bottom accessories (mini players), tab bar minimize-on-scroll, or hiding tabs conditionally. Trigger this skill on any mention of `NativeTabs`, `expo-router/unstable-native-tabs`, "native tabs", "liquid glass tabs", "iOS tab bar", "Expo tabs".
---

# Expo Native Tabs

This skill covers `NativeTabs` from `expo-router/unstable-native-tabs` — the Expo Router layout that renders the platform's real system tab bar (UITabBar on iOS, Material Tabs on Android) instead of a JavaScript-rendered tab bar. Use it when the user wants the native look and feel: liquid glass on iOS 26, system Material tabs on Android, SF Symbols, badges that match the OS, and behaviors like scroll-to-top and pop-to-top that are wired up at the platform level.

Native tabs are in **alpha** as of SDK 54 and the API is subject to change. Several features (compound `NativeTabs.Trigger.Icon`/`Label`/`Badge` API, `hidden` prop, asset catalog icons, bottom accessory, safe area handling, `disablePopToTop`/`disableScrollToTop` on Android) require **SDK 55 or later** — call this out when the user's question depends on it.

## When to reach for native tabs vs alternatives

Expo Router has three tab layouts. Pick based on what the user actually needs:

- **Native tabs** (this skill) — `expo-router/unstable-native-tabs`. Real system tab bar. Best when the user wants the platform-native look (liquid glass, Material tabs) and is OK with the constraints those system components impose. Cannot be deeply customized.
- **JavaScript tabs** — `expo-router`'s `<Tabs />`. React Navigation's bottom tabs, fully JS-rendered. Best when the user already uses React Navigation tabs or needs a fully custom-styled tab bar that still behaves like a typical mobile tab bar.
- **Custom headless tabs** — `expo-router/ui` (`Tabs`, `TabList`, `TabTrigger`, `TabSlot`). Best when the user needs a fully custom design with no system tab bar at all (web layouts, sidebar nav, top tabs, etc).

If the user is unsure, ask what they're after. If they say "I want it to look like a native iOS app" or "liquid glass", go native tabs. If they say "I want full control over how it looks", go JavaScript or headless.

## Core mental model

Native tabs use file-based routing for screen content + an explicit `<NativeTabs.Trigger>` per route in the layout file. **Unlike Stack, tabs are NOT auto-added** — every tab you want in the tab bar needs an explicit `Trigger`.

A typical setup looks like this:

```
app/
  _layout.tsx       // <NativeTabs> with one <NativeTabs.Trigger /> per tab
  index.tsx         // first tab content (default tab on app load)
  settings.tsx      // second tab content
```

Minimal `_layout.tsx`:

```tsx
import { NativeTabs } from 'expo-router/unstable-native-tabs';

export default function TabLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name='index'>
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf='house.fill' md='home' />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name='settings'>
        <NativeTabs.Trigger.Icon sf='gear' md='settings' />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
```

The `name` on each `Trigger` matches the route filename (without extension). `index` is the default tab.

## Customizing tab bar items

### Icons

`NativeTabs.Trigger.Icon` accepts three icon sources:

- `sf="house.fill"` — Apple SF Symbols (iOS only)
- `md="home"` — Android Material Symbols (Android only, SDK 55+)
- `src={require('./icon.png')}` — custom image (cross-platform)
- `xcasset="icon-name"` — Xcode asset catalog (iOS only, SDK 55+)

Pass the same icon to both `sf` and `md` to cover both platforms. To use different icons for default vs selected states (iOS only), pass an object: `sf={{ default: 'house', selected: 'house.fill' }}`.

For custom image icons, control coloring with `renderingMode` (SDK 55+, iOS only):

- `'template'` (default) — icon is tinted by iOS to match the tab bar tint color. Use for single-color icons.
- `'original'` — preserves original colors. Use for gradients or multi-color icons.

On Android, image icons always use their original colors regardless of `renderingMode`.

### Liquid glass icon coloring on iOS

Liquid glass changes color based on the underlying background. There's no callback for this, so use `PlatformColor` or `DynamicColorIOS` for icon and label colors that need to adapt:

```tsx
import { DynamicColorIOS } from 'react-native';

<NativeTabs
  labelStyle={{
    color: DynamicColorIOS({ dark: 'white', light: 'black' }),
  }}
  tintColor={DynamicColorIOS({ dark: 'white', light: 'black' })}
>
  {/* triggers */}
</NativeTabs>;
```

### Labels

`NativeTabs.Trigger.Label` takes a string child. If omitted, the route name is used. Hide it with the `hidden` prop:

```tsx
<NativeTabs.Trigger.Label hidden />
```

### Badges

`NativeTabs.Trigger.Badge` shows a notification mark on the tab. Pass a string for a counter; pass no child for a plain dot:

```tsx
<NativeTabs.Trigger.Badge>9+</NativeTabs.Trigger.Badge>
<NativeTabs.Trigger.Badge />
```

## Hiding tabs

There are two distinct cases:

**Hiding the entire tab bar** (SDK 55+): `<NativeTabs hidden={...}>`. To toggle this from a screen, lift state via Context (the docs use a `TabBarContext` pattern with a `setIsTabBarHidden` setter, then a screen calls it inside `useFocusEffect`).

**Hiding a single tab conditionally**: `<NativeTabs.Trigger name="messages" hidden={...} />` — but be careful here. **Dynamically toggling `hidden` remounts the navigator and resets state.** Only flip it before the navigator mounts or while it's not visible. A `hidden` tab cannot be navigated to at all.

If you need true dynamic add/remove of tabs at runtime, you can't — that's a known limitation. Apple's HIG actually recommends against it.

## Behavior props on `NativeTabs.Trigger`

These all affect what happens when a user taps an already-active tab:

- `disablePopToTop` (SDK 55+ on Android) — by default, tapping the active tab pops its stack to root. Set this to keep the current screen.
- `disableScrollToTop` (SDK 55+ on Android) — by default, tapping the active tab on the root screen scrolls the first `ScrollView` to top. Set this to disable.
- `disableTransparentOnScrollEdge` — on iOS 18 and earlier, the tab bar goes transparent when content scrolls to the edge (or there's no scrollable content). Set this to keep it opaque. Also useful with `FlatList`, where scroll-edge detection is unreliable.
- `disableAutomaticContentInsets` (SDK 55+) — on iOS, the first nested `ScrollView` gets automatic content inset adjustment so content scrolls behind the tab bar. Disable this for full manual control, then handle insets with `SafeAreaView` from `react-native-screens/experimental`.

## iOS 26 features (require Xcode 26+)

### Search tab

Mark a tab as the system search tab with `role="search"`:

```tsx
<NativeTabs.Trigger name='search' role='search'>
  <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
</NativeTabs.Trigger>
```

For an actual search field embedded in the tab bar, nest a `Stack` inside the search route and use `Stack.SearchBar` with `headerSearchBarOptions` / `placement="automatic"`.

### Tab bar minimize on scroll

```tsx
<NativeTabs minimizeBehavior="onScrollDown">
```

### Bottom accessory (SDK 55+)

A floating view above the tab bar — perfect for a mini music player. **Two instances render simultaneously** (one for `'regular'` placement, one for `'inline'`/compact), so state must live **outside** the accessory component. Use `NativeTabs.BottomAccessory.usePlacement()` inside the accessory to render different UIs per placement.

```tsx
function MiniPlayer({ isPlaying, onToggle }) {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  if (placement === 'inline') return <CompactUI />;
  return <FullUI />;
}

export default function TabLayout() {
  const [isPlaying, setIsPlaying] = useState(false); // state lives here, not in MiniPlayer
  return (
    <NativeTabs>
      <NativeTabs.BottomAccessory>
        <MiniPlayer
          isPlaying={isPlaying}
          onToggle={() => setIsPlaying(!isPlaying)}
        />
      </NativeTabs.BottomAccessory>
      {/* triggers */}
    </NativeTabs>
  );
}
```

## Stacks inside tabs

Native tabs do **not** render a header. If the user wants a header per tab or wants to push screens within a tab, nest a `Stack` inside the tab's route folder:

```
app/
  _layout.tsx          // NativeTabs
  search/
    _layout.tsx        // export default () => <Stack />
    index.tsx          // search root, can use Stack.Screen.Title etc.
    [id].tsx           // pushed screen
```

This is the right answer when migrating from JavaScript tabs — those had a "mock" stack header built in; native tabs don't.
