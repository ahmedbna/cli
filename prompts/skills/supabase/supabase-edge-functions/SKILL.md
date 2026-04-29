---
name: supabase-edge-functions
description: Deno-based Edge Functions for webhooks, third-party API calls, custom auth flows, and scheduled jobs.
---

# Supabase Edge Functions

Deno-based serverless endpoints. Use for webhooks (Stripe, Clerk, GitHub), third-party API calls needing secrets, server-side enforcement RLS can't express, and scheduled jobs.

## Project structure

```
supabase/
└── functions/
    ├── _shared/
    │   ├── cors.ts          # Reusable CORS headers
    │   └── supabase.ts      # Service-role client factory
    ├── stripe-webhook/
    │   └── index.ts
    └── send-email/
          └── index.ts
```

Files prefixed with `_` are not deployed.

## Anatomy

```ts
// supabase/functions/hello/index.ts
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { name } = await req.json();
    return new Response(JSON.stringify({ message: `Hello ${name}` }), {
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

```ts
// supabase/functions/_shared/cors.ts
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // tighten in production
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
```

**Notes:**
- `Deno.serve`, not `serve()` from `std/http`.
- URL imports with explicit versions: `import { Stripe } from 'https://esm.sh/stripe@14.0.0?target=deno'`. NPM: `npm:openai@4.0.0`.
- Handler must return `Response`. Plain objects silently fail.
- File extensions in imports are mandatory: `'../_shared/cors.ts'`.

## Two client types

### Identity-bound client (acts as the calling user)

```ts
// _shared/supabase.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function getSupabaseUserClient(req: Request) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: req.headers.get('Authorization')! } },
      auth: { persistSession: false },
    },
  );
}
```

### Admin client (bypasses RLS)

```ts
export function getSupabaseAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
```

`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL` are **auto-injected** — don't `secrets set` them.

**Rule of thumb:**
- Function accepts user JWT → user client.
- Webhook (no user JWT) → admin client.
- Both → user client to verify, then admin for privileged write.

```ts
const userClient = getSupabaseUserClient(req);
const { data: { user } } = await userClient.auth.getUser();
if (!user) return new Response('Unauthorized', { status: 401 });

const admin = getSupabaseAdminClient();
await admin.from('audit_log').insert({ user_id: user.id, action: 'X' });
```

## Verifying webhooks (Stripe example)

Two non-negotiables: **disable JWT verification** AND **read the raw body** before parsing.

```toml
[functions.stripe-webhook]
verify_jwt = false
```

```ts
import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { getSupabaseAdminClient } from '../_shared/supabase.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(), // required in Deno
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('No signature', { status: 400 });

  // CRITICAL: raw body, not req.json()
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    return new Response(`Bad signature: ${(err as Error).message}`, {
      status: 400,
    });
  }

  const admin = getSupabaseAdminClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await admin.from('subscriptions').upsert({
        user_id: session.client_reference_id,
        stripe_customer_id: session.customer as string,
        status: 'active',
      });
      break;
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
```

Use `constructEventAsync` (sync uses Node `crypto`). Same pattern for any webhook signature.

## Secrets

Reserved (auto-injected): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.

Custom secrets:

```bash
# Local: write to supabase/.env (gitignored)
echo 'STRIPE_SECRET_KEY=sk_test_...' >> supabase/.env

# Production
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets list
```

Read with `Deno.env.get('NAME')`. Always null-check.

## Calling functions

### From Expo client

```ts
const { data, error } = await supabase.functions.invoke('hello', {
  body: { name: 'World' },
});
```

`supabase.functions.invoke` auto-forwards the user JWT. Inside the function, `auth.getUser()` works.

### From a webhook

```
https://<project-ref>.supabase.co/functions/v1/stripe-webhook
```

Local: `http://127.0.0.1:54321/functions/v1/stripe-webhook`. Use ngrok/smee.io for webhook tunnels in dev.

### Disabling JWT verification

```toml
[functions.stripe-webhook]
verify_jwt = false

[functions.github-webhook]
verify_jwt = false
```

With `verify_jwt = false`, verify identity yourself (signature, shared secret).

## Local development

```bash
supabase functions serve              # all functions, hot reload
supabase functions serve hello        # single function
supabase functions serve --env-file supabase/.env hello
```

## Deploy

```bash
supabase functions deploy
supabase functions deploy stripe-webhook --no-verify-jwt
```

Prefer `verify_jwt = false` in `config.toml` (checked into git) over `--no-verify-jwt`.

## Scheduled functions (cron)

Use `pg_cron` to invoke functions on a schedule:

```sql
-- One-time setup
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Daily 2am UTC
select cron.schedule(
  'daily-cleanup',
  '0 2 * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/daily-cleanup',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    )
  );
  $$
);
```

Store the service role key as a DB setting:

```sql
alter database postgres set app.settings.service_role_key = '<your-service-role-key>';
```

Manage:

```sql
select cron.unschedule('daily-cleanup');
select * from cron.job;
```

## Hard rules

- **Don't bare-import npm packages.** Use `npm:` or `esm.sh`.
- **Don't `req.json()` before signature verification** — `req.text()` first, verify, then parse.
- **Don't use the wrong client.** Webhooks → admin. User → user client.
- **Don't ship `verify_jwt = false` without a replacement check.**
- **Don't put `SUPABASE_SERVICE_ROLE_KEY` in client code.**
- **Don't forget the OPTIONS handler.**
- **Don't use sync Stripe APIs** — use `*Async` in Deno.
- **Don't deploy without testing locally.**
- **Don't forget `supabase secrets set` for prod.**

## New function checklist

1. `supabase functions new <name>` or create dir + `index.ts`.
2. Identity-bound or admin client?
3. `verify_jwt`? Webhook → `false` + signature check.
4. OPTIONS handler with CORS headers.
5. `req.text()` for webhooks, `req.json()` otherwise.
6. Set secrets locally (`supabase/.env`) and prod (`supabase secrets set`).
7. Test with `supabase functions serve`, then `supabase functions deploy`.
