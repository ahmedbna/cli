---
name: convex-presence
description: Use when implementing real-time user presence, online indicators, "who's here" lists, or live user status with Convex. Trigger on "presence", "online indicator", "who's online", "live users", "active users", "real-time presence", "FacePile", or showing which users are currently active in a room/document/channel.
---

# Convex Presence Component

`@convex-dev/presence` — live-updating list of users in a "room" with last-seen status. Uses Convex scheduled functions so clients only get updates when someone **joins or leaves**, not on every heartbeat. No polling, no per-heartbeat re-renders.

## Install

React Native (Expo) — add `expo-crypto`:

```bash
npm install @convex-dev/presence
npx expo install expo-crypto
```

## Setup

### `convex/convex.config.ts`

```ts
import { defineApp } from 'convex/server';
import presence from '@convex-dev/presence/convex.config';

const app = defineApp();
app.use(presence);
export default app;
```

### `convex/presence.ts`

You **must** expose three functions: `heartbeat`, `list`, and `disconnect`. The names matter because the `usePresence` hook calls them by convention.

```ts
import { mutation, query } from './_generated/server';
import { components } from './_generated/api';
import { v } from 'convex/values';
import { Presence } from '@convex-dev/presence';
import { getAuthUserId } from '@convex-dev/auth/server';

export const presence = new Presence(components.presence);

export const heartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { roomId, userId, sessionId, interval }) => {
    // Auth check — enforce that userId matches the caller
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error('Not authenticated');
    return await presence.heartbeat(
      ctx,
      roomId,
      authUserId,
      sessionId,
      interval,
    );
  },
});

export const list = query({
  args: { roomToken: v.string() },
  handler: async (ctx, { roomToken }) => {
    // Keep this query free of per-user reads so all subscribers share the cache
    return await presence.list(ctx, roomToken);
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => {
    // Called over HTTP from sendBeacon on tab close — auth headers may not be present
    return await presence.disconnect(ctx, sessionToken);
  },
});
```

> ⚠️ **Don't add per-user reads inside `list`.** The docs are explicit: keeping the query identical for every subscriber lets all clients share the same Convex query cache. If you want per-user data (avatar, display name), join it client-side or with a separate query — not inside `list`.

## Client usage

### React Native — different import path

```tsx
import { usePresence } from '@convex-dev/presence/react-native';
import { api } from '@/convex/_generated/api';

function RoomPresence({ userName }: { userName: string }) {
  const presenceState = usePresence(api.presence, 'doc-123', userName);
  // FacePile is web-only — render your own avatars on RN
  return (
    <View style={{ flexDirection: 'row' }}>
      {(presenceState ?? []).map((p) => (
        <Avatar key={p.userId} userId={p.userId} online={p.online} />
      ))}
    </View>
  );
}
```

`usePresence` arguments:

1. The presence API (`api.presence`)
2. Room identifier (string) — anything that uniquely identifies the room/doc/channel
3. The user's identity (string) — typically a userId or display name

The hook handles heartbeats and graceful disconnect on tab close / unmount automatically.

## Additional helpers

The `Presence` class exposes more than the three required functions. Most useful:

- **`presence.listUser(ctx, userId)`** — check whether a specific user is online in **any** room. Wrap it in your own query to power "is X online?" indicators outside a specific room.

See `@convex-dev/presence/src/client/index.ts` for the full interface.

## Notes

- **`<FacePile />` is web-only.** For React Native, use the `usePresence` hook directly and render avatars with your own components.
- Heartbeat logic is internal — you don't call `heartbeat` from the client; the hook does it.
- The `disconnect` mutation can't reliably check auth because browsers fire it via `sendBeacon` on tab close, where headers may be stripped. Trust the `sessionToken` (it's opaque and tied to a session).
- For an authenticated example, see the `example-with-auth` directory in [the GitHub repo](https://github.com/get-convex/presence).
