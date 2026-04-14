---
name: expo-routing
description: Use when implementing navigation, file-based routing, tabs, dynamic routes, or protected routes with Expo Router. Trigger on "navigation", "routing", "tabs", "tab bar", "NativeTabs", "dynamic route", "router.push", "Link", "protected route", or any screen navigation pattern.
---

# Expo Router — File-Based Routing

## Directory = Route Group

Files inside `app/` map directly to routes:
- `app/index.tsx` → `/`
- `app/(home)/index.tsx` → `/` (within the home group)
- `app/(home)/settings.tsx` → `/settings`
- `app/profile/[id].tsx` → `/profile/:id` (dynamic route)

## Layouts

`_layout.tsx` files wrap child routes:

```tsx
// app/_layout.tsx — Root layout
import { Stack } from "expo-router";
export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

## Navigation

```tsx
import { router } from "expo-router";

// Navigate
router.push("/profile/123");
router.replace("/home");
router.back();

// With Link component
import { Link } from "expo-router";
<Link href="/settings">Go to Settings</Link>
```

## Dynamic routes

```tsx
// app/profile/[id].tsx
import { useLocalSearchParams } from "expo-router";

export default function Profile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AppText>Profile {id}</AppText>;
}
```

## Tab navigation (NativeTabs)

```tsx
// app/(home)/_layout.tsx
import { NativeTabs, Icon, Label, VectorIcon } from 'expo-router/unstable-native-tabs';
import Feather from '@expo/vector-icons/Feather';

export default function HomeLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        {Platform.select({
          ios: <Icon sf="house.fill" />,
          android: <Icon src={<VectorIcon family={Feather} name="home" />} />,
        })}
        <Label>Home</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
```

## Protected routes

Use `(home)` group with auth check in the root layout:

```tsx
// app/_layout.tsx
const user = useQuery(api.auth.loggedInUser);
if (user === undefined) return <Spinner />;
if (!user) return <Authentication />;
return <Stack />;
```

## Rules

- Max 5 tabs in bottom tab bar
- Route group names in parentheses: `(home)`, `(auth)`
- Only use `(home)` as the protected group name in BNA templates
- Dynamic segments use brackets: `[id].tsx`, `[...slug].tsx`
- `+not-found.tsx` handles 404s
