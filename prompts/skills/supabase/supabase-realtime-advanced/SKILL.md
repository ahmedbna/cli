---
name: supabase-realtime-advanced
description: Use when subscribing to live data in Supabase from an Expo app — postgres changes, presence (who's online), broadcast (chat, cursors), or realtime authorization. Trigger on "supabase.channel", "realtime", "postgres_changes", "subscribe", "presence", "broadcast", "live updates", "real-time", "channel.unsubscribe", "removeChannel", "trackPresence", "useEffect cleanup", "channel auth", or any feature that needs sub-second updates rather than polling.
---

# Supabase Realtime on Expo

Realtime is the right tool for chat, presence, collaborative cursors, and any UI where polling would feel wrong. **It's the wrong tool for everything else** — TanStack Query with `invalidateQueries` after mutations covers normal data flow with much less complexity. Reach for realtime only when the UX demands sub-second freshness.

There are three completely separate realtime systems on one channel API:

| Mode                 | What it sends                             | When to use                       |
| -------------------- | ----------------------------------------- | --------------------------------- |
| **Postgres Changes** | INSERT/UPDATE/DELETE events from Postgres | Watching a table change           |
| **Broadcast**        | Arbitrary client-to-client messages       | Chat, cursors, anything ephemeral |
| **Presence**         | "who's online" tracking on a channel      | Active users, typing indicators   |

You can use all three on the same channel. You can also footgun yourself with all three.

## The lifecycle that prevents 90% of bugs

Every realtime bug in Expo comes from getting subscription lifecycle wrong. The pattern that always works:

```tsx
useEffect(() => {
  const channel = supabase
    .channel(`messages:${roomId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        // handle the new row
        queryClient.setQueryData(
          ['messages', roomId],
          (old: Message[] = []) => [...old, payload.new as Message],
        );
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel); // ← this line is non-negotiable
  };
}, [roomId]);
```

What goes wrong without this:

- **Memory leak**: every screen mount adds another subscription, the old ones never die. Ten navigations later you're getting ten copies of every event.
- **Stale closures**: the handler captures whatever `queryClient` / `userId` was at mount. After re-render those are gone.
- **Wrong channel name**: `supabase.channel('messages')` joined twice gets you one channel for the whole app — events from room A leak into room B. Always include the discriminator in the name.

`supabase.removeChannel(channel)` is the only correct cleanup. **Do not** call `channel.unsubscribe()` and stop there — `unsubscribe` leaves the channel registered and the next `.channel(sameName)` call returns the dead one. `removeChannel` calls `unsubscribe` AND deregisters.

## Realtime + TanStack Query: the right pattern

The mistake: replacing `useQuery` with raw realtime subscriptions. You then have no initial load, no caching, no error retries.

The right pattern: `useQuery` for the snapshot, realtime for _updates_, both writing to the same cache key.

```tsx
function useMessages(roomId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['messages', roomId],
    queryFn: () => api.messages.list(roomId),
  });

  useEffect(() => {
    const channel = supabase
      .channel(`messages:${roomId}`)
      .on(
        'postgres_changes',
        {
          event: '*', // INSERT | UPDATE | DELETE
          schema: 'public',
          table: 'messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          queryClient.setQueryData<Message[]>(
            ['messages', roomId],
            (old = []) => {
              if (payload.eventType === 'INSERT') {
                // Dedupe — the optimistic insert may already be there
                if (old.some((m) => m.id === payload.new.id)) return old;
                return [...old, payload.new as Message];
              }
              if (payload.eventType === 'UPDATE') {
                return old.map((m) =>
                  m.id === payload.new.id ? (payload.new as Message) : m,
                );
              }
              if (payload.eventType === 'DELETE') {
                return old.filter((m) => m.id !== payload.old.id);
              }
              return old;
            },
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, queryClient]);

  return query;
}
```

`event: '*'` subscribes to all change types. The `payload.eventType` discriminator tells you which.

## Postgres Changes — make sure your table is enabled

This is the silent failure mode: your subscription "works" (no errors, status `SUBSCRIBED`) but no events ever arrive. Reason: the table isn't in the publication.

```sql
-- supabase/migrations/0007_realtime.sql
-- Add tables you want to broadcast changes for
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.posts;
```

Required for **every** table you want realtime on. The default `supabase_realtime` publication is empty.

For `UPDATE` and `DELETE` events to include the `old` row data (default is just the primary key), set replica identity:

```sql
alter table public.messages replica identity full;
```

Without it, `payload.old` only has `{ id }` and any RLS filtering on old-row columns fails silently.

### Filters

`filter` uses a tiny postgrest syntax: `'column=eq.value'`, `'column=in.(1,2,3)'`. **Single column only**. You can't combine multiple columns with AND. If you need multi-column filtering, subscribe broadly and filter in the handler.

```ts
.on('postgres_changes', {
  event: 'INSERT',
  schema: 'public',
  table: 'messages',
  filter: `room_id=eq.${roomId}`,
}, ...)
```

### RLS applies

A realtime event is delivered to a client only if the client could `SELECT` that row under RLS. This is automatic but matters for design: don't have a "private flag" you set on a row to "hide" it from other users — they'll still get the realtime event up until the flag is set, and there's no event for "row became invisible to you."

For sensitive realtime data, keep RLS strict and design the schema so the existence of a row is itself the signal.

## Broadcast — for chat, cursors, anything ephemeral

Postgres Changes is for "the database changed and everyone watching needs to know." Broadcast is for "a client wants to tell other clients something" without touching the DB. Cheaper, faster, gets dropped if no one is listening.

```ts
// In one client (the sender)
const channel = supabase.channel(`room:${roomId}`);
channel.subscribe(async (status) => {
  if (status === 'SUBSCRIBED') {
    await channel.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { x: 100, y: 200, userId: 'abc' },
    });
  }
});

// In other clients (the listeners)
const channel = supabase
  .channel(`room:${roomId}`)
  .on('broadcast', { event: 'cursor' }, (payload) => {
    console.log('cursor moved:', payload.payload);
  })
  .subscribe();

return () => {
  supabase.removeChannel(channel);
};
```

### Self-broadcast

By default, the sender does not receive their own broadcast event. To get echoes (e.g. for confirmation), pass `{ self: true }` when creating the channel:

```ts
supabase.channel(`room:${roomId}`, {
  config: { broadcast: { self: true } },
});
```

### Acknowledgments

For "did this message arrive on the server" confirmation:

```ts
const channel = supabase.channel(`room:${roomId}`, {
  config: { broadcast: { ack: true } },
});

const status = await channel.send({
  type: 'broadcast',
  event: 'msg',
  payload: { text: 'hi' },
});
// status: 'ok' | 'timed out' | 'rate limited'
```

This guarantees the _server_ received it, **not** that any other client did. If "delivered" matters, write to the database and use postgres changes.

## Presence — who's online

Presence syncs a small piece of state (typically `{ userId, name }`) across all clients on a channel. Used for "X is typing", online indicators, collaborative editing avatars.

```tsx
function usePresence(roomId: string, user: { id: string; name: string }) {
  const [online, setOnline] = useState<Record<string, any>>({});

  useEffect(() => {
    const channel = supabase.channel(`room:${roomId}`, {
      config: { presence: { key: user.id } }, // unique per user
    });

    channel
      .on('presence', { event: 'sync' }, () => {
        setOnline(channel.presenceState());
      })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        await channel.track({ name: user.name, online_at: Date.now() });
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, user.id, user.name]);

  return online;
}
```

The `presence.key` is critical — without it, the same user opening two tabs counts as two separate presences, and refreshing the app loses the slot. Use the user's id.

`channel.track()` only works _after_ `subscribe()` returns `SUBSCRIBED`. Calling it earlier silently no-ops. Always call inside the subscribe callback.

`presenceState()` returns `Record<key, Array<state>>`. Multiple entries per key means the same user has multiple connections (multiple devices). Flatten or pick the most recent depending on UI needs.

## React Native specifics

### AppState — pause realtime when backgrounded

The same problem as auth refresh. JS timers freeze when the app backgrounds, websocket goes quiet, server eventually drops the connection. When the user returns, `subscribe()` returns `CLOSED` instead of reconnecting.

Supabase's realtime client _does_ attempt reconnection, but on iOS/Android it's unreliable across long backgrounding. Belt-and-suspenders pattern: re-subscribe on foreground.

```tsx
useEffect(() => {
  let channel = subscribeToChannel();

  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      // Re-create on foreground in case the connection died
      supabase.removeChannel(channel);
      channel = subscribeToChannel();
    }
  });

  return () => {
    sub.remove();
    supabase.removeChannel(channel);
  };
}, []);
```

For a chat app this is essential. For a low-traffic dashboard you can skip it.

### Don't subscribe in `app/_layout.tsx` to "global" things

The temptation: "subscribe to user updates at the root, everywhere downstream gets reactivity for free." Three problems:

1. The subscription survives logouts → leaks into the next user's session.
2. RLS rejects updates because the JWT is stale → silent failure.
3. Re-renders cascade through the whole app on every event.

Subscribe at the screen level, scoped to whatever the user is looking at. The connection cost of `supabase.channel()` is negligible.

## Channel authorization (private channels)

Broadcast and presence don't naturally respect RLS — anyone who knows a channel name can join. For private rooms, enable channel authorization:

```ts
const channel = supabase.channel(`room:${roomId}`, {
  config: { private: true },
});
```

Then add a policy on `realtime.messages`:

```sql
create policy "private_room_authorize"
  on realtime.messages for select
  using (
    -- Only members of the room can subscribe
    public.is_room_member(
      replace((realtime.topic())::text, 'room:', '')::uuid
    )
  );
```

Without this, anyone with the project's anon key can `supabase.channel('room:abc')` and listen in. Postgres changes are always RLS-protected; broadcast and presence are not unless you opt in.

## Hard rules

- **Don't forget `removeChannel` in cleanup.** Memory leak guaranteed.
- **Don't reuse a channel name across screens.** Always include a discriminator (`messages:${roomId}`).
- **Don't use `channel.unsubscribe()` alone.** Use `supabase.removeChannel(channel)`.
- **Don't replace `useQuery` with realtime.** Use both — query for snapshot, realtime for diffs.
- **Don't forget to add tables to `supabase_realtime` publication.** Silent failure.
- **Don't subscribe before authentication is loaded.** RLS will reject and you'll get nothing — for the rest of the screen's lifetime.
- **Don't trust `payload.old` without `replica identity full`.** It only has the PK by default.
- **Don't call `channel.track()` outside the `SUBSCRIBED` callback.** It silently no-ops.
- **Don't use realtime for things polling can do.** TanStack Query with `staleTime: 30_000` and `refetchOnWindowFocus: true` covers 90% of "fresh enough" needs.
- **Don't broadcast secrets.** Broadcast/presence go to all subscribers. Don't put auth tokens, API keys, or anything you wouldn't show every member of the room.

## Quick checklist for a realtime feature

1. **Decide the mode**: postgres changes (DB-backed) / broadcast (ephemeral) / presence (online state).
2. **Channel name includes a discriminator**: `messages:${roomId}`, never just `messages`.
3. **For postgres changes**: `alter publication supabase_realtime add table ...` in a migration.
4. **For UPDATE/DELETE with full row data**: `alter table ... replica identity full`.
5. **Subscription lives in `useEffect`** with `removeChannel(channel)` in cleanup.
6. **Pair with `useQuery`** — query for initial data, realtime for diffs into the same cache key.
7. **Handle AppState for chat-grade apps** — reconnect on foreground.
8. **Private rooms?** Set `config: { private: true }` and add a policy on `realtime.messages`.
