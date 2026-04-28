---
name: expo-supabase-notifications
description: Use when wiring expo-notifications into a Supabase backend — storing Expo push tokens in a Postgres table with RLS, sending pushes from a Supabase Edge Function via the Expo Push API, fanning out to multiple devices, scheduling pushes with pg_cron, or handling delivery receipts. Trigger on "Supabase push notifications", "Supabase notifications", "store push token in Supabase", "send notification from Supabase", "Expo push API from edge function", "scheduled notification Supabase", "pg_cron push", or any flow where the Expo client needs to register a token with Supabase and Supabase needs to push back. Read the base `expo-notifications` skill first for the client-side pieces, and `supabase-edge-functions` for general Edge Function mechanics — this skill picks up where those end.
---

# Expo + Supabase Notifications

This is the Supabase-side companion to `expo-notifications`. The base skill covers the client (permissions, channels, getting the token, scheduling local notifications). This skill covers everything that lives on the server: storing the token in Postgres with RLS, sending pushes via the Expo Push Service from a Supabase Edge Function, and scheduling them with pg_cron.

The mental model: the client inserts/updates its token in a `push_tokens` table directly (RLS makes it safe). When a push needs to go out, an Edge Function — either invoked from the app, from a webhook, or from pg_cron — looks up the relevant tokens with the service role key and POSTs to Expo's push API.

## 1. Migration — the `push_tokens` table

Tokens belong on a separate table, not on `public.users`. One user can have multiple devices (phone + tablet), tokens rotate independently per device, and a join table makes RLS clean.

```sql
-- supabase/migrations/0005_push_tokens.sql
create table public.push_tokens (
  id           uuid primary key default extensions.uuid_generate_v4(),
  user_id      uuid not null references public.users(id) on delete cascade,
  token        text not null unique,                 -- ExponentPushToken[...]
  platform     text not null check (platform in ('ios', 'android')),
  device_name  text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

-- RLS — every public table needs this enabled. The anon key is shipped to
-- every client; without RLS this is a public data leak.
alter table public.push_tokens enable row level security;

-- A user can read, insert, update, delete their own tokens. Nothing else.
create policy "push_tokens_select_self"
  on public.push_tokens for select
  using (auth.uid() = user_id);

create policy "push_tokens_insert_self"
  on public.push_tokens for insert
  with check (auth.uid() = user_id);

create policy "push_tokens_update_self"
  on public.push_tokens for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "push_tokens_delete_self"
  on public.push_tokens for delete
  using (auth.uid() = user_id);
```

The `unique` constraint on `token` is what makes the upsert pattern work — re-registration on cold start patches the existing row instead of creating a duplicate.

After applying:

```bash
npm run db:reset
npm run db:types
```

## 2. API module — `supabase/api/pushTokens.ts`

Following the project's "no `supabase.from()` in UI code" rule, all token logic lives in the api module. Mirror of how `users.ts` is structured.

```ts
// supabase/api/pushTokens.ts
import { supabase } from '@/supabase/client';
import { ApiError, requireUserId } from './_helpers';

export const pushTokens = {
  /**
   * Idempotent register — call this every time the client gets a token.
   * Re-registration just updates last_seen_at. The unique constraint on
   * `token` plus `onConflict` makes this safe.
   */
  async register(args: {
    token: string;
    platform: 'ios' | 'android';
    deviceName?: string;
  }) {
    const userId = await requireUserId();
    const { error } = await supabase.from('push_tokens').upsert(
      {
        user_id: userId,
        token: args.token,
        platform: args.platform,
        device_name: args.deviceName,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
    if (error) throw new ApiError(error.message, error.code, error);
  },

  /** Remove a single token — call this on sign-out to stop pushes to this device. */
  async remove(token: string) {
    const userId = await requireUserId();
    // RLS already restricts to own rows, but explicit eq matches both keys
    // for clarity and sidesteps a needless full-table scan.
    const { error } = await supabase
      .from('push_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('token', token);
    if (error) throw new ApiError(error.message, error.code, error);
  },
};
```

Add it to the api barrel:

```ts
// supabase/api/index.ts
import { users } from './users';
import { auth } from './auth';
import { pushTokens } from './pushTokens';

export const api = { users, auth, pushTokens };
```

## 3. Client — register on sign-in, listen for rotation

Use the `registerForPushNotificationsAsync` helper from the base `expo-notifications` skill, then push the token to Supabase once authenticated:

```tsx
// hooks/usePushTokenSync.ts
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/supabase/api';
import { registerForPushNotificationsAsync } from './registerForPushNotificationsAsync';

export function usePushTokenSync() {
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;

    let active = true;

    registerForPushNotificationsAsync().then((token) => {
      if (!active || !token) return;
      api.pushTokens.register({
        token,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceName: Device.deviceName ?? undefined,
      });
    });

    // Token rotation — fires when FCM/APNs invalidates the old token.
    // Without this, the device silently stops receiving pushes.
    const sub = Notifications.addPushTokenListener((next) => {
      api.pushTokens.register({
        token: next.data,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        deviceName: Device.deviceName ?? undefined,
      });
    });

    return () => {
      active = false;
      sub.remove();
    };
  }, [isAuthenticated]);
}
```

Mount it inside the authenticated branch of your root layout. Sign-out should also call `api.pushTokens.remove(token)` before `signOut()` — otherwise the device keeps getting pushes after a logout.

## 4. Edge Function — `send-push`

This is where the actual sending happens. RLS doesn't apply here because we're using the service role client — that's required because we need to read tokens for users other than the caller (e.g., sending a push to the recipient of a new message).

Read the `supabase-edge-functions` skill for the general structure (CORS, OPTIONS handler, admin client). Specifics for this function:

```ts
// supabase/functions/send-push/index.ts
import { corsHeaders } from '../_shared/cors.ts';
import { getSupabaseAdminClient } from '../_shared/supabase.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type ExpoPushMessage = {
  to: string;
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
        error?:
          | 'DeviceNotRegistered'
          | 'InvalidCredentials'
          | 'MessageTooBig'
          | 'MessageRateExceeded';
      };
    };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { userId, title, body, data } = (await req.json()) as {
      userId: string;
      title: string;
      body: string;
      data?: Record<string, unknown>;
    };

    const admin = getSupabaseAdminClient();

    const { data: tokens, error } = await admin
      .from('push_tokens')
      .select('id, token, platform')
      .eq('user_id', userId);
    if (error) throw error;
    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      data,
      sound: 'default',
      // channelId must match a channel created on-device. The base
      // expo-notifications skill creates a 'default' channel during
      // registration; if you use named channels per feature, override here.
      channelId: t.platform === 'android' ? 'default' : undefined,
    }));

    const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(messages),
    });

    const json = (await res.json()) as { data: ExpoTicket[] };

    // Walk tickets in lockstep with tokens. DeviceNotRegistered → drop the row.
    let sent = 0;
    const deadIds: string[] = [];
    for (let i = 0; i < json.data.length; i++) {
      const ticket = json.data[i];
      const token = tokens[i];
      if (ticket.status === 'ok') {
        sent++;
        continue;
      }
      if (ticket.details?.error === 'DeviceNotRegistered') {
        deadIds.push(token.id);
      } else {
        console.error('Push failed:', ticket.message, token.id);
      }
    }
    if (deadIds.length > 0) {
      await admin.from('push_tokens').delete().in('id', deadIds);
    }

    return new Response(JSON.stringify({ sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
```

## 5. Locking it down

Two threats to defend against. Pick the one that matches your setup.

**A. App-only sending (most common).** Keep `verify_jwt = true` — the default. Only authenticated users of your app can invoke the function. This is fine when pushes are user-initiated (sending a chat message, etc.). But the client picks `userId` — so add a server-side check that the caller is allowed to push to that user (e.g., they're in the same conversation).

**B. Webhook / cron sending.** Set `verify_jwt = false` in `config.toml`, then verify identity yourself with a shared secret:

```toml
[functions.send-push]
verify_jwt = false
```

```ts
const fnSecret = Deno.env.get('PUSH_FN_SECRET')!;
if (req.headers.get('x-function-secret') !== fnSecret) {
  return new Response('Forbidden', { status: 403 });
}
```

For local development, put the values in `supabase/functions/.env` (auto-loaded by `supabase start` and `supabase functions serve`):

```
EXPO_ACCESS_TOKEN=expo_test_xxx
PUSH_FN_SECRET=local_dev_secret
```

For production, push them with `supabase secrets set` — no redeploy needed, they're available on the next invocation:

```bash
supabase secrets set PUSH_FN_SECRET=$(openssl rand -hex 32)
supabase secrets set EXPO_ACCESS_TOKEN=<your expo access token>
```

See the `supabase-environment-variables` skill for the full secrets workflow (bulk loading from `.env`, choosing between built-in keys, debugging "undefined in prod", etc.).

Skipping the secret and leaving `verify_jwt = false` open means anyone on the internet can push to any of your users.

## 6. Triggering pushes — three patterns

**Pattern 1: From the client after a user action.** Example: user sends a chat message, then immediately invoke the function to push the recipient.

```ts
// somewhere after the message is inserted
await supabase.functions.invoke('send-push', {
  body: {
    userId: recipientId,
    title: 'New message',
    body: messageText.slice(0, 100),
    data: { url: `/chat/${conversationId}` },
  },
});
```

**Pattern 2: From a Postgres trigger.** Cleaner for "every new row in `messages` pushes the recipient" type flows. Uses `pg_net` to fire-and-forget the function call.

```sql
create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
as $$
begin
  perform net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-function-secret', current_setting('app.settings.push_fn_secret')
    ),
    body := jsonb_build_object(
      'userId', new.recipient_id,
      'title', 'New message',
      'body', left(new.body, 100),
      'data', jsonb_build_object('url', '/chat/' || new.conversation_id)
    )
  );
  return new;
end;
$$;

create trigger messages_push_notify
  after insert on public.messages
  for each row execute function public.notify_new_message();
```

The settings (`app.settings.supabase_url`, `app.settings.push_fn_secret`) come from one-time `alter database postgres set` calls — see the `supabase-edge-functions` skill.

**Pattern 3: pg_cron for scheduled pushes.** Daily digests, retention pings, scheduled reminders.

```sql
select cron.schedule(
  'morning digest',
  '0 14 * * *',  -- 9am EST
  $$
  select net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/morning-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-function-secret', current_setting('app.settings.push_fn_secret')
    )
  );
  $$
);
```

`morning-digest` is a separate Edge Function that does whatever query work you need and either calls `send-push` per recipient or does the Expo POST itself (cleaner to keep one HTTP-to-Expo function and have other functions delegate to it via in-process logic or another invoke).

## 7. Fan-out: sending to many users

Expo's API accepts up to 100 messages per request. For broadcasts, chunk:

```ts
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Inside a broadcast Edge Function:
const { data: allTokens } = await admin
  .from('push_tokens')
  .select('id, token, platform');

for (const group of chunk(allTokens ?? [], 100)) {
  const messages = group.map((t) => ({
    to: t.token,
    title,
    body,
    channelId: t.platform === 'android' ? 'default' : undefined,
  }));
  await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
}
```

Edge Functions have execution time limits (currently around 60 seconds wall-clock). For broadcasts to tens of thousands of users, kick off pg_cron-style background work that processes batches across multiple invocations rather than trying to do it in one call.

## 8. Receipts (delivery confirmation)

The response from `/push/send` is a **ticket** ("we accepted this") — not delivery confirmation. To confirm delivery, store ticket IDs and poll `/push/getReceipts` 15+ minutes later. Most consumer apps don't need this; transactional pushes (where loss is unacceptable) do. The pattern is the same as Convex: save ticket IDs to a `push_receipts` table, schedule a pg_cron job to drain them ~15 minutes later, react to `DeviceNotRegistered` by deleting tokens.

## Hard rules

- **RLS on every public table — `push_tokens` included.** The anon key is in your client bundle. One un-RLSed table is a leak.
- **Don't put tokens on `users`.** Multi-device + rotation makes a join table the right shape.
- **Upsert on `token`, not on `id`.** The unique constraint plus `onConflict: 'token'` makes registration idempotent. Inserting blindly accumulates duplicates with every cold start.
- **Use the service role admin client inside `send-push`.** You need to read tokens for `userId` other than `auth.uid()` — RLS would block that. The admin client bypasses RLS; just verify the caller's authorization yourself before reading.
- **Always honor `DeviceNotRegistered`.** Delete the token row when Expo says the device is gone. Otherwise dead tokens accumulate and broadcasts get slower.
- **Set `channelId` on Android messages.** The base skill creates a `default` channel during registration — match it here. Without `channelId`, FCM uses a fallback that produces ugly defaults.
- **Lock down the Edge Function.** Either keep `verify_jwt = true` and authorize per-call, or `verify_jwt = false` plus a shared secret header. Don't leave it open with no replacement check.
- **Set `EXPO_ACCESS_TOKEN` in production.** Without it, anyone with one of your push tokens can push through your account.
- **Remove tokens on sign-out.** A signed-out user keeps getting pushes if you don't.
- **Don't await the function call inside a user-facing flow.** `supabase.functions.invoke` is async — fire it and let it run; don't block the UI on the push being sent.
