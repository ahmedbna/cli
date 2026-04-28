---
name: expo-convex-notifications
description: Use when wiring expo-notifications into a Convex backend — storing Expo push tokens on the users table, sending pushes from Convex actions or scheduled functions via the Expo Push API, fanning out to multiple devices, or handling delivery receipts. Trigger on "Convex push notifications", "Convex notifications", "store push token in Convex", "send notification from Convex", "Expo push API from Convex", "scheduled notification Convex", "notification action Convex", or any flow where the Expo client needs to register a token with Convex and Convex needs to push back. Read the base `expo-notifications` skill first for the client-side pieces — this skill picks up where that one ends.
---

# Expo + Convex Notifications

This is the Convex-side companion to `expo-notifications`. The base skill covers the client (permissions, channels, getting the token, scheduling local notifications). This skill covers everything that lives on the server: storing the token, sending pushes via the Expo Push Service from a Convex action, and scheduling them.

The mental model: the client calls a Convex mutation to upsert its token, and Convex calls Expo's HTTP API from an action whenever it wants to push. Mutations can't make network calls — that's why sending pushes always goes through an `action` (or `internalAction`).

## 1. Schema — store tokens on a separate table

Don't shove tokens into the `users` table directly. One user can have multiple devices (phone + tablet, work + personal), and tokens rotate independently per device. A small join table is the right shape:

```ts
// convex/schema.ts (additions)
import { v } from 'convex/values';
import { authTables } from '@convex-dev/auth/server';
import { defineSchema, defineTable } from 'convex/server';

export default defineSchema({
  ...authTables,

  users: defineTable({
    // … existing user fields …
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
  }).index('email', ['email']),

  pushTokens: defineTable({
    userId: v.id('users'),
    token: v.string(), // ExponentPushToken[...]
    platform: v.union(v.literal('ios'), v.literal('android')),
    deviceName: v.optional(v.string()), // helpful for debugging
    lastSeenAt: v.number(), // ms epoch — used to prune dead tokens
  })
    .index('byToken', ['token']) // upsert lookup
    .index('byUser', ['userId']), // fan-out lookup
});
```

The `byToken` index is the important one — when the client re-registers (which happens on every cold start, plus whenever the token rotates) you find-by-token to decide whether to insert or patch. Without it you'd accumulate duplicate rows for the same device.

## 2. Mutation — upsert the token

This runs every time the client gets a token. It's idempotent: re-registering the same token just updates `lastSeenAt`.

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
      // Token might have been previously bound to a different user (rare:
      // same device, two accounts). Re-bind to the current user.
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

    // Only let users delete their own tokens.
    if (row && row.userId === userId) await ctx.db.delete(row._id);
  },
});

// Used by the action below to look up where to send.
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

Sign-out should also remove the token. Wire it into your existing sign-out button: call `removePushToken` with the current token before calling `signOut()`. Skipping this means the user keeps getting notifications meant for the device they signed out of.

## 3. Client — register on sign-in, listen for rotation

Use the `registerForPushNotificationsAsync` helper from the base `expo-notifications` skill, then push the token to Convex once the user is authenticated:

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

    // Token rotation — fires when FCM/APNs invalidates the old token.
    // If we don't catch this, the device silently stops receiving pushes.
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

Mount this hook somewhere inside `<Authenticated>` in your root layout — it's a no-op until the user is logged in.

## 4. Action — send pushes via Expo Push API

This is the heart of the system. Convex actions can make network calls (queries and mutations cannot), so server-side push sending lives here. Use an `internalAction` so it can only be invoked from other Convex functions, not from the client.

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
  channelId?: string; // Android — must match a setNotificationChannelAsync id
  priority?: 'default' | 'normal' | 'high';
  ttl?: number; // seconds
  _contentAvailable?: boolean; // iOS background notifications
};

type ExpoTicket =
  | { status: 'ok'; id: string }
  | {
      status: 'error';
      message: string;
      details?: {
        error?:
          | 'DeviceNotRegistered'
          | 'InvalidCredentials'
          | 'MessageTooBig'
          | 'MessageRateExceeded';
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

    // One message per token (Expo also accepts arrays of `to`, but per-token
    // gives cleaner error handling and matches receipt semantics).
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

    // Walk the tickets in lockstep with the tokens we sent. If Expo says
    // a device is no longer registered, drop that token from the DB so we
    // stop wasting requests on it.
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

Calling it from another Convex function:

```ts
// e.g. inside a mutation that creates a new message
await ctx.scheduler.runAfter(0, internal.notifications.sendToUser, {
  userId: recipientId,
  title: 'New message',
  body: messageText.slice(0, 100),
  data: { url: `/messages/${conversationId}` }, // tap → deep link to that screen
});
```

`scheduler.runAfter(0, ...)` is the Convex idiom for "kick this off but don't block the mutation." It runs the action immediately in a separate transaction.

## 5. Fan-out: sending to many users

Expo's API accepts up to 100 messages per request. For larger fan-outs (broadcast to all subscribers, etc.), chunk:

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

`allTokens` is just an `internalQuery` returning `await ctx.db.query('pushTokens').collect()`.

## 6. Scheduled / cron pushes

Convex has built-in cron, no separate service required. Reminder pushes, daily digests, retention pings — all live in `convex/crons.ts`:

```ts
// convex/crons.ts
import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.daily(
  'morning digest',
  { hourUTC: 14, minuteUTC: 0 }, // 9am EST
  internal.notifications.sendDigest,
);

export default crons;
```

`sendDigest` is just another `internalAction` that does whatever query → action work you want and calls into `sendToUser` per recipient.

## 7. Authenticated tokens (production)

The Expo Push API is open by default. For production, generate an **access token** in your Expo dashboard (Account → Access Tokens) and send it as a bearer header. This stops anyone who scrapes a token out of your app from spamming pushes through your account.

Set it as a Convex env var:

```bash
npx convex env set EXPO_ACCESS_TOKEN <token>
```

Then in the action:

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

The response from `/push/send` is a **ticket** ("we accepted this") — not delivery confirmation. To confirm delivery, store the ticket IDs and poll `/push/getReceipts` 15+ minutes later. For most consumer apps you don't need this. If you do (transactional pushes where loss is unacceptable), the pattern is:

1. Save `ticketId`s from the send response.
2. After ~15 minutes (a `scheduler.runAfter(15 * 60 * 1000, ...)`), POST those IDs to `https://exp.host/--/api/v2/push/getReceipts`.
3. Receipts with `status: 'error'` and `details.error: 'DeviceNotRegistered'` mean: drop that token. Same with `MessageTooBig`, `InvalidCredentials`, etc.

## Hard rules

- **Don't put tokens on the `users` table.** Multi-device support and rotation become annoying. Use the join table shape above.
- **`registerPushToken` is idempotent — keep it that way.** Find-by-token → patch or insert. Never blindly insert; you'll accumulate duplicates with every cold start.
- **Send pushes from `action` / `internalAction`, never from `mutation`.** Mutations can't `fetch`. Trying to will fail at runtime with a clear error, but better to know upfront.
- **Always honor `DeviceNotRegistered`.** Delete the token row when Expo says the device is gone. Otherwise you carry dead tokens forever and your fan-outs get slower.
- **Set `channelId` on Android messages.** Without it, Android uses your default channel — which only exists if you configured `defaultChannel` in the `expo-notifications` config plugin or called `setNotificationChannelAsync('default', ...)` on the client. Don't rely on FCM's fallback; it shows ugly defaults.
- **Use `internalAction` for sending**, not `action`. The client should never be able to send arbitrary pushes — only the server. Public `action`s are callable from the client with no further auth checks beyond what you write.
- **Remove tokens on sign-out.** A signed-out user keeps getting pushes if you don't.
- **Don't await the action inside a user-facing mutation.** Use `ctx.scheduler.runAfter(0, ...)` so the mutation returns instantly and the push happens in the background.
- **For prod, set `EXPO_ACCESS_TOKEN`.** Without it, anyone with one of your push tokens can impersonate your server.
