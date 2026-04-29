---
name: convex-presence
description: Real-time user presence ("who's online", live indicators) via the `@convex-dev/presence` component.
---

# Convex Presence Component

`@convex-dev/presence` — live-updating list of users in a "room" with last-seen status. Uses scheduled functions so clients only get updates when someone **joins or leaves**, not on every heartbeat.

## Install

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

You **must** expose three functions: `heartbeat`, `list`, and `disconnect` — names matter (the hook calls them by convention).

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
    // Called via sendBeacon on tab close — auth headers may not be present
    return await presence.disconnect(ctx, sessionToken);
  },
});
```

> ⚠️ **Don't add per-user reads inside `list`.** Identical queries let all clients share the cache. Join per-user data client-side or in a separate query.

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
2. Room identifier (string)
3. The user's identity (string) — typically userId or display name

The hook handles heartbeats and graceful disconnect automatically.

## Notes

- **`<FacePile />` is web-only.** On RN, use `usePresence` directly.
- Heartbeat is internal — you don't call it; the hook does.
- `presence.listUser(ctx, userId)` — check whether a user is online in any room.
