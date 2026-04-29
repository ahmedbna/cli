---
name: expo-supabase-notifications
description: Wire expo-notifications into Supabase — store push tokens with RLS, send via Edge Function + Expo Push API, schedule with pg_cron. Read `expo-notifications` skill first.
---

# Expo + Supabase Notifications

Client inserts/updates token in a `push_tokens` table (RLS-protected). When pushing, an Edge Function uses the service role key to read tokens and POSTs to Expo's push API.

## 1. Migration — `push_tokens` table

Use a join table, not `public.users` — multi-device support + rotation requires it.

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

alter table public.push_tokens enable row level security;

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

The `unique` constraint on `token` makes upsert work — re-registration patches existing rows.

```bash
npm run db:reset
npm run db:types
```

## 2. API module — `supabase/api/pushTokens.ts`

```ts
import { supabase } from '@/supabase/client';
import { ApiError, requireUserId } from './_helpers';

export const pushTokens = {
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

  async remove(token: string) {
    const userId = await requireUserId();
    const { error } = await supabase
      .from('push_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('token', token);
    if (error) throw new ApiError(error.message, error.code, error);
  },
};
```

```ts
// supabase/api/index.ts
import { users } from './users';
import { auth } from './auth';
import { pushTokens } from './pushTokens';

export const api = { users, auth, pushTokens };
```

## 3. Client — register on sign-in, listen for rotation

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

    // Token rotation
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

Mount inside the authenticated branch. Sign-out should call `api.pushTokens.remove(token)` before `signOut()`.

## 4. Edge Function — `send-push`

Uses the service role admin client to read tokens for users other than caller (RLS would block).

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
        error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'MessageTooBig' | 'MessageRateExceeded';
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

**A. App-only sending.** Keep `verify_jwt = true` (default). Only authenticated users can invoke. Add server-side authorization check (caller can push to that userId).

**B. Webhook/cron sending.** Set `verify_jwt = false` and verify with shared secret:

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

Local dev — `supabase/functions/.env`:

```
EXPO_ACCESS_TOKEN=expo_test_xxx
PUSH_FN_SECRET=local_dev_secret
```

Production:

```bash
supabase secrets set PUSH_FN_SECRET=$(openssl rand -hex 32)
supabase secrets set EXPO_ACCESS_TOKEN=<your expo access token>
```

## 6. Triggering pushes

**Pattern 1: From the client**:

```ts
await supabase.functions.invoke('send-push', {
  body: {
    userId: recipientId,
    title: 'New message',
    body: messageText.slice(0, 100),
    data: { url: `/chat/${conversationId}` },
  },
});
```

**Pattern 2: From a Postgres trigger** (uses `pg_net`):

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

**Pattern 3: pg_cron for scheduled pushes**:

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

## 7. Fan-out

Expo accepts up to 100 messages per request:

```ts
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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

Edge Functions have ~60s wall-clock limit. For tens of thousands of users, batch across pg_cron invocations.

## 8. Receipts

`/push/send` returns **tickets** — not delivery confirmation. For transactional pushes, save ticket IDs to a `push_receipts` table, drain via pg_cron 15+ min later, drop tokens on `DeviceNotRegistered`.

## Hard rules

- **RLS on every public table.** Anon key ships in client bundle.
- **Don't put tokens on `users`** — use the join table.
- **Upsert on `token`** with `onConflict: 'token'`. Idempotent registration.
- **Service role admin client in `send-push`** — needed to read other users' tokens.
- **Honor `DeviceNotRegistered`** — delete the token row.
- **Set `channelId` on Android** — match the on-device channel.
- **Lock down the Edge Function** — either `verify_jwt: true` + authorization, or `verify_jwt: false` + shared secret.
- **Set `EXPO_ACCESS_TOKEN` in production.**
- **Remove tokens on sign-out.**
- **Don't await `supabase.functions.invoke` in user-facing flows.**
