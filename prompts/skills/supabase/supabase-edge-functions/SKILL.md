---
name: supabase-edge-functions
description: Use when writing Supabase Edge Functions — Deno-based serverless endpoints for webhooks, third-party API integrations, custom auth flows, server-side logic, scheduled jobs, or anything that needs the service_role key. Trigger on "edge function", "supabase functions", "Deno", "Deno.serve", "functions deploy", "functions/_shared", "service_role", "stripe webhook", "verify webhook", "cron", "scheduled function", "createClient with service role", or any server-side code that runs in Supabase's runtime.
---

# Supabase Edge Functions

Edge Functions are **Deno**-based (not Node) serverless endpoints that run on Supabase's edge. Use them for: webhooks (Stripe, Clerk, GitHub), third-party API calls that need a secret, server-side enforcement of rules RLS can't express, and scheduled jobs. Don't use them for simple data fetches — that's what RLS-protected `from('table').select()` from the client is for.

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

Anything under `_shared/` is _not_ deployed as a function — files prefixed with `_` are skipped. Use it for code reused across functions.

## Anatomy of a function — get this exactly right

```ts
// supabase/functions/hello/index.ts
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  // 1. Handle CORS preflight first — browsers send OPTIONS before POST.
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

**Things that trip people up:**

- It's **`Deno.serve`**, not `serve()` from `std/http`. The newer Deno runtime built into Supabase exposes it globally.
- All imports use **URL imports** with explicit versions: `import { Stripe } from 'https://esm.sh/stripe@14.0.0?target=deno'`. No `package.json`, no `node_modules`. NPM compatibility works via `npm:` specifiers in newer runtimes (`import OpenAI from 'npm:openai@4.0.0'`) — pin versions explicitly.
- The handler must return a `Response`. Returning a plain object silently fails.
- File extensions in imports are **mandatory**: `'../_shared/cors.ts'`, not `'../_shared/cors'`.

## Two clients, very different — pick the right one

The biggest, most expensive bug in edge functions: using the wrong key. Each gives you a different identity and different RLS behavior.

### Identity-bound client (acts as the calling user)

Forwards the user's JWT, RLS applies, you can call `auth.getUser()`:

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

### Admin client (bypasses RLS, full database access)

```ts
export function getSupabaseAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
```

`SUPABASE_SERVICE_ROLE_KEY` is **automatically injected** into every edge function — you don't set it via `secrets set`. Same for `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_DB_URL`. These four are reserved.

**Rule of thumb:**

- If the function accepts a user JWT and acts on their behalf → user client.
- If it's a webhook (no user JWT exists) → admin client.
- If it's both (signed-in user triggers something with elevated rights) → use user client to verify identity, then admin client for the privileged write.

```ts
// Check identity, then escalate
const userClient = getSupabaseUserClient(req);
const {
  data: { user },
} = await userClient.auth.getUser();
if (!user) return new Response('Unauthorized', { status: 401 });

const admin = getSupabaseAdminClient();
await admin.from('audit_log').insert({ user_id: user.id, action: 'X' });
```

## Verifying webhooks (Stripe example)

Webhooks must verify signatures or you'll happily process forged events. The two correct things must both be true: **disable JWT verification** for the function (Stripe doesn't send a Supabase JWT), and **read the raw body** (verification fails on parsed JSON).

Disable JWT verification in `config.toml`:

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

`stripe.webhooks.constructEvent` (sync version) doesn't work in Deno — it uses Node's `crypto`. Always use `constructEventAsync`. Same pattern for any signature verification (Clerk, GitHub, etc.) — read raw body, then parse only after verifying.

## Secrets and environment variables

Reserved (auto-injected, don't set yourself): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.

Custom secrets:

```bash
# Local: write to supabase/.env (gitignored)
echo 'STRIPE_SECRET_KEY=sk_test_...' >> supabase/.env

# Production: push them to the deployed env
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets list   # see what's set
```

Read with `Deno.env.get('NAME')`. Always null-check or throw at startup — Deno doesn't have a TypeScript guarantee for env vars.

## Calling functions

### From the Expo client

```ts
const { data, error } = await supabase.functions.invoke('hello', {
  body: { name: 'World' },
});
```

`supabase.functions.invoke` automatically forwards the user's JWT in `Authorization: Bearer ...`. Inside the function, the user client picks it up and `auth.getUser()` works.

### From a webhook (curl / Stripe / GitHub)

```
https://<project-ref>.supabase.co/functions/v1/stripe-webhook
```

For local dev: `http://127.0.0.1:54321/functions/v1/stripe-webhook`. Webhook providers can't reach `localhost` — use [ngrok](https://ngrok.com) or [smee.io](https://smee.io) to tunnel during development.

### Disabling JWT verification

By default every function requires a valid Supabase JWT in the Authorization header. Webhooks need this **off**:

```toml
[functions.stripe-webhook]
verify_jwt = false

[functions.github-webhook]
verify_jwt = false
```

When `verify_jwt = false`, you have to verify identity yourself (signature check, shared secret in a header, etc.). Don't leave it off without a replacement.

## Local development

```bash
supabase functions serve              # serve all functions, hot reload
supabase functions serve hello        # single function
supabase functions serve --env-file supabase/.env hello    # explicit env file
```

The local runtime is the same Deno binary as production. If it works locally and breaks in prod, it's almost always: a missing secret, a missing `verify_jwt = false`, or a CORS header mismatch.

## Deploy

```bash
# Deploy all functions
supabase functions deploy

# Or one at a time
supabase functions deploy stripe-webhook --no-verify-jwt
```

The `--no-verify-jwt` flag on the CLI is a one-off override; the proper place is `verify_jwt = false` in `config.toml` so it's checked into git.

## Scheduled functions (cron)

Use `pg_cron` to invoke an edge function on a schedule. The function still runs on edge — pg_cron just triggers it via HTTP.

```sql
-- Enable extensions (one-time, in a migration)
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Schedule a daily job at 2am UTC
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

Set the service role key as a database setting once: `alter database postgres set app.settings.service_role_key = '<your-service-role-key>';` (admin-only, run via migration with the service role).

`select cron.unschedule('daily-cleanup');` removes a job. List with `select * from cron.job;`.

## Hard rules

- **Don't import from npm without `npm:` or esm.sh.** Bare specifiers like `import Stripe from 'stripe'` don't work — Deno has no `node_modules`.
- **Don't `req.json()` before signature verification.** Webhook signatures cover the raw body. Always `await req.text()` first, verify, then `JSON.parse`.
- **Don't use the wrong client.** Webhooks → admin. User actions → user client. Verify identity with user client, escalate with admin only when needed.
- **Don't ship `verify_jwt = false` without a replacement check.** Webhook signature, IP allowlist, shared secret — pick one.
- **Don't put `SUPABASE_SERVICE_ROLE_KEY` in client code.** It's reserved server-side. Edge functions get it auto-injected; clients never need it.
- **Don't forget the OPTIONS handler.** Browsers will preflight. Without it, every web call from a different origin fails CORS.
- **Don't use the synchronous Stripe APIs (`constructEvent`, etc.).** Use `*Async` versions in Deno.
- **Don't deploy without testing locally.** `supabase functions serve` is the same runtime — if it doesn't work there, it won't work in prod.
- **Don't forget to `supabase secrets set` for prod.** The local `supabase/.env` is dev-only. Forgetting this is the #1 prod-only failure.

## Quick checklist for a new function

1. `supabase functions new <name>` (or just create the dir + `index.ts`).
2. Decide: identity-bound or admin client? If both, use a helper.
3. Decide: `verify_jwt`? Webhook → false + signature check. User-facing → leave default true.
4. Add OPTIONS handler with CORS headers.
5. Read body the right way: `req.text()` for webhooks, `req.json()` after.
6. Set secrets locally (`supabase/.env`) and in prod (`supabase secrets set`).
7. Test locally with `supabase functions serve`, then `supabase functions deploy`.
