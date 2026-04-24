---
name: convex-presence
description: Use when implementing real-time user presence, online indicators, or live user status with Convex. Trigger on "presence", "online indicator", "who's online", "live users", "real-time presence", or showing which users are currently active.
---

# Convex Presence Component

Manages live-updating user presence in a "room" without polling — uses scheduled functions so clients only update when users join/leave.

## Installation

```bash
npx expo install @convex-dev/presence expo-crypto
```

## Setup

### convex/convex.config.ts

```ts
import { defineApp } from "convex/server";
import presence from "@convex-dev/presence/convex.config";
const app = defineApp();
app.use(presence);
export default app;
```

### convex/presence.ts

```ts
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { Presence } from "@convex-dev/presence";
import { getAuthUserId } from "@convex-dev/auth/server";

export const presence = new Presence(components.presence);

export const getUserId = query({
  args: {},
  handler: async (ctx) => getAuthUserId(ctx),
});

export const heartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Not authenticated");
    return presence.heartbeat(ctx, args.roomId, authUserId, args.sessionId, args.interval);
  },
});

export const list = query({
  args: { roomToken: v.string() },
  handler: async (ctx, { roomToken }) => {
    const list = await presence.list(ctx, roomToken);
    return Promise.all(list.map(async (entry) => {
      const user = await ctx.db.get(entry.userId as any);
      return user ? { ...entry, name: user.name, image: user.image } : entry;
    }));
  },
});

export const disconnect = mutation({
  args: { sessionToken: v.string() },
  handler: async (ctx, { sessionToken }) => presence.disconnect(ctx, sessionToken),
});
```

## Usage in React Native

```tsx
import { usePresence } from '@convex-dev/presence/react-native';
import { api } from '@/convex/_generated/api';

function PresenceIndicator({ userId }: { userId: string }) {
  const presenceState = usePresence(api.presence, 'my-room', userId);
  return <FacePile presenceState={presenceState ?? []} />;
}
```

## PresenceState type

```ts
interface PresenceState {
  userId: string;
  online: boolean;
  lastDisconnected: number;
  data?: Record<string, unknown>;
  name?: string;
  image?: string;
}
```
