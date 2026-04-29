---
name: expo-convex-notifications
description: Wire expo-notifications into Convex — store push tokens, send pushes from actions/scheduled functions via the Expo Push API. Read `expo-notifications` skill first.
---

# Expo + Convex Notifications

The Convex-side companion to `expo-notifications`. Client calls a mutation to upsert its token; Convex calls Expo's HTTP API from an `action`. Mutations can't make network calls.

## 1. Schema — store tokens in a join table

Don't put tokens on `users`. One user can have multiple devices; tokens rotate per-device.

```ts
// convex/schema.ts (additions)
import { v } from 'convex/values';
import { authTables } from '@convex-dev/auth/server';
import { defineSchema, defineTable } from 'convex/server';

export default defineSchema({
  ...authTables,

  users: defineTable({
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
  }).index('email', ['email']),

  pushTokens: defineTable({
    userId: v.id('users'),
    token: v.string(), // ExponentPushToken[...]
    platform: v.union(v.literal('ios'), v.literal('android')),
    deviceName: v.optional(v.string()),
    lastSeenAt: v.number(),
  })
    .index('byToken', ['token'])
    .index('byUser', ['userId']),
});
```

The `byToken` index is critical — find-by-token to decide insert vs patch on re-registration.

## 2. Mutation — upsert the token

Idempotent: re-registering the same token just updates `lastSeenAt`.

```ts
// convex/notifications.ts
import { v } from 'convex/values';
import { getAuthUserId } from '@convex-dev/auth/server';
import { mutation, internalMutation, internalQuery } from './_generated/server';

export const registerPushToken = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
    deviceName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error('Not authenticated');

    const existing = await ctx.db
      .query('pushTokens')
      .withIndex('byToken', (q) => q.eq('token', args.token))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        userId,
        platform: args.platform,
        deviceName: args.deviceName,
        lastSeenAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert('pushTokens', {
      userId,
      token: args.token,
      platform: args.platform,
      deviceName: args.deviceName,
      lastSeenAt: Date.now(),
    });
  },
});

export const removePushToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error('Not authenticated');

    const row = await ctx.db
      .query('pushTokens')
      .withIndex('byToken', (q) => q.eq('token', token))
      .unique();

    if (row && row.userId === userId) await ctx.db.delete(row._id);
  },
});

export const tokensForUser = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query('pushTokens')
      .withIndex('byUser', (q) => q.eq('userId', userId))
      .collect();
  },
});

export const deleteTokenInternal = internalMutation({
  args: { tokenId: v.id('pushTokens') },
  handler: async (ctx, { tokenId }) => {
    await ctx.db.delete(tokenId);
  },
});
```

Sign-out should call `removePushToken` with the current token.

## 3. Client — register on sign-in, listen for rotation

```tsx
// hooks/usePushTokenSync.ts
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useMutation, useConvexAuth } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { registerForPushNotificationsAsync } from './registerForPushNotificationsAsync';

export function usePushTokenSync() {
  const { isAuthenticated } = useConvexAuth();
  const registerToken = useMutation(api.notifications.registerPushToken);

  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;

    registerForPushNotificationsAsync().then((token) => {
      if (!active || !token) return;
      registerToken({
        token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceName: Device.deviceName ?? undefined,
      });
    });

    // Token rotation — fires when FCM/APNs invalidates the old token
    const sub = Notifications.addPushTokenListener((next) => {
      registerToken({
        token: next.data,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceName: Device.deviceName ?? undefined,
      });
    });

    return () => {
      active = false;
      sub.remove();
    };
  }, [isAuthenticated, registerToken]);
}
```

Mount inside `<Authenticated>` in your root layout.

## 4. Action — send pushes via Expo Push API

Use `internalAction` so only Convex functions can invoke it.

```ts
// convex/notifications.ts (continued)
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type ExpoPushMessage = {
  to: string | string[];
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
  _contentAvailable?: boolean;
};

type ExpoTicket =
  | { status: 'ok'; id: string }
  | {
      status: 'error';
      message: string;
      details?: {
        error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'MessageTooBig' | 'MessageRateExceeded';
      };
    };

export const sendToUser = internalAction({
  args: {
    userId: v.id('users'),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const tokens = await ctx.runQuery(internal.notifications.tokensForUser, {
      userId: args.userId,
    });
    if (tokens.length === 0) return { sent: 0 };

    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      title: args.title,
      body: args.body,
      data: args.data,
      sound: 'default',
      channelId: t.platform === 'android' ? 'default' : undefined,
    }));

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    });

    const json = (await res.json()) as { data: ExpoTicket[] };

    let sent = 0;
    for (let i = 0; i < json.data.length; i++) {
      const ticket = json.data[i];
      const token = tokens[i];
      if (ticket.status === 'ok') {
        sent++;
        continue;
      }
      if (ticket.details?.error === 'DeviceNotRegistered') {
        await ctx.runMutation(internal.notifications.deleteTokenInternal, {
          tokenId: token._id,
        });
      } else {
        console.error('Push failed:', ticket.message, token._id);
      }
    }

    return { sent };
  },
});
```

Calling from another function:

```ts
await ctx.scheduler.runAfter(0, internal.notifications.sendToUser, {
  userId: recipientId,
  title: 'New message',
  body: messageText.slice(0, 100),
  data: { url: `/messages/${conversationId}` },
});
```

## 5. Fan-out (broadcast to many users)

Expo accepts up to 100 messages per request. Chunk for larger sends:

```ts
export const broadcast = internalAction({
  args: { title: v.string(), body: v.string(), data: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const allTokens = await ctx.runQuery(internal.notifications.allTokens, {});
    const chunks = chunk(allTokens, 100);

    for (const group of chunks) {
      const messages = group.map((t) => ({
        to: t.token,
        title: args.title,
        body: args.body,
        data: args.data,
        channelId: t.platform === 'android' ? 'default' : undefined,
      }));
      await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
    }
  },
});

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
```

## 6. Scheduled / cron pushes

```ts
// convex/crons.ts
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.daily(
  'morning digest',
  { hourUTC: 14, minuteUTC: 0 },
  internal.notifications.sendDigest,
);

export default crons;
```

## 7. Authenticated tokens (production)

Generate an access token (Expo dashboard → Account → Access Tokens) to prevent abuse:

```bash
npx convex env set EXPO_ACCESS_TOKEN <token>
```

```ts
const accessToken = process.env.EXPO_ACCESS_TOKEN;
const res = await fetch(EXPO_PUSH_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  },
  body: JSON.stringify(messages),
});
```

## 8. Receipts (delivery confirmation)

Send response is a **ticket** ("accepted") — not delivery confirmation. To confirm delivery:
1. Save `ticketId`s.
2. After ~15 minutes (`scheduler.runAfter(15 * 60 * 1000, ...)`), POST IDs to `https://exp.host/--/api/v2/push/getReceipts`.
3. `DeviceNotRegistered`/`MessageTooBig`/`InvalidCredentials` → drop the token.

## Hard rules

- **Don't put tokens on the `users` table.** Use the join table.
- **`registerPushToken` is idempotent** — find-by-token, then patch or insert.
- **Send from `action`/`internalAction`, never from `mutation`.** Mutations can't `fetch`.
- **Honor `DeviceNotRegistered`** — delete the token row.
- **Set `channelId` on Android messages.** Match a `setNotificationChannelAsync('default', ...)` ID on the client.
- **Use `internalAction` for sending** — clients shouldn't send arbitrary pushes.
- **Remove tokens on sign-out.**
- **Don't await the action inside a user-facing mutation** — use `scheduler.runAfter(0, ...)`.
- **For prod, set `EXPO_ACCESS_TOKEN`.**
