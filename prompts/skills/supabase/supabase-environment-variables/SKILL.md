---
name: supabase-environment-variables
description: Use when handling environment variables and secrets for Supabase Edge Functions or any Supabase server-side code — reading them with Deno.env.get, setting up the local supabase/functions/.env file, deploying secrets to production with `supabase secrets set`, picking the right built-in secret (SUPABASE_URL, SUPABASE_ANON_KEY vs SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEYS vs SUPABASE_SECRET_KEYS), or debugging "secret is undefined in production" issues. Trigger on "supabase secrets", "supabase env", "Deno.env.get", "supabase functions/.env", "secrets set", "service role key", "anon key", "publishable key", "SB_REGION", "DENO_DEPLOYMENT_ID", "edge function environment", or anything about loading API keys (Stripe, OpenAI, Resend, etc.) into a Supabase Edge Function.
---

# Supabase Environment Variables

Edge Functions are Deno processes; they read environment variables with `Deno.env.get`. There are two layers to manage: **built-in secrets** that Supabase injects automatically, and **custom secrets** you provide (Stripe keys, OpenAI keys, webhook signing secrets, etc.).

This skill is the one place that covers both. Use it whenever an Edge Function needs to read configuration, or whenever a "works locally, undefined in prod" mystery appears — that's almost always a missing `supabase secrets set`.

## The two layers

**Built-in (auto-injected, never set yourself):**

| Secret                      | What it is                                       | Where it's safe to use                 |
| --------------------------- | ------------------------------------------------ | -------------------------------------- |
| `SUPABASE_URL`              | API gateway URL for your project                 | Anywhere                               |
| `SUPABASE_DB_URL`           | Direct Postgres connection string                | Edge Functions only                    |
| `SUPABASE_PUBLISHABLE_KEYS` | JSON dict of `publishable` keys (new key system) | Browser-safe, RLS applies              |
| `SUPABASE_SECRET_KEYS`      | JSON dict of `secret` keys (new key system)      | Edge Functions only — **bypasses RLS** |
| `SUPABASE_ANON_KEY`         | Legacy anon key                                  | Browser-safe, RLS applies              |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy service role key                          | Edge Functions only — **bypasses RLS** |

**Hosted-runtime-only (informational, can't change):**

| Variable             | What it is                                                           |
| -------------------- | -------------------------------------------------------------------- |
| `SB_REGION`          | Region the function was invoked in                                   |
| `SB_EXECUTION_ID`    | UUID of the function isolate handling this request                   |
| `DENO_DEPLOYMENT_ID` | `{project_ref}_{function_id}_{version}` — useful for log correlation |

**Custom (you set these):** Stripe keys, OpenAI keys, webhook secrets, Expo access tokens, etc.

## Reading them

`Deno.env.get` returns `string | undefined` — TypeScript can't enforce that the var exists, so handle the absence:

```ts
// Throw at startup if a required secret is missing — better than failing
// mysteriously on the first request.
const stripeSecret = Deno.env.get('STRIPE_SECRET_KEY');
if (!stripeSecret) throw new Error('STRIPE_SECRET_KEY is not set');

// Or use a non-null assertion when you've verified it exists somewhere else
const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
```

Don't use the non-null assertion for custom secrets without checking — that's the bug that produces `Cannot read properties of undefined` six layers deep into the Stripe SDK in production while it works fine locally.

## Built-in secrets — picking the right client

Two clients, very different behavior. Get this wrong and you either bypass RLS by accident (data leak) or get blocked by RLS when you didn't mean to (mysterious empty queries).

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';

// User-facing client. Forwards the caller's JWT, RLS applies, auth.uid()
// works inside policies. Use this in any function called from your app
// where the action is "on behalf of" the user.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_ANON_KEY')!,
  {
    global: { headers: { Authorization: req.headers.get('Authorization')! } },
    auth: { persistSession: false },
  },
);

// Admin client. Bypasses RLS entirely. Use this in webhook handlers, cron
// jobs, or when a privileged write is required after verifying identity.
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
```

**Rule of thumb:** if the function accepts a user JWT and acts on their behalf, use the user client. If it's a webhook, cron job, or trigger-driven, use admin. If it's both — verify with the user client first, then escalate with admin only for the privileged write.

### Old vs new key names

The new `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` are JSON dictionaries (multiple keys per project, rotatable). Most code is still written against the legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` strings, and both work. Stick with the legacy names unless you're specifically using the new key system — every example in the wild and most of the supabase-js docs still use the old names.

## Local development

Two ways to load secrets locally. Both work; pick one and be consistent.

**Option A — automatic, default file location:**

Create `supabase/functions/.env`:

```
STRIPE_SECRET_KEY=sk_test_xxx
EXPO_ACCESS_TOKEN=expo_test_xxx
RESEND_API_KEY=re_test_xxx
```

Then `supabase start` and `supabase functions serve` load it automatically. Zero ceremony.

**Option B — explicit, custom file:**

```bash
supabase functions serve --env-file .env.local
supabase functions serve hello-world --env-file ./supabase/.env.staging
```

Useful when you want different env files for different scenarios (local dev vs running against a hosted project for testing). The CLI flag overrides the default file location.

**Always gitignore both forms:**

```
# .gitignore
supabase/functions/.env
supabase/.env
.env.local
.env*.local
```

A leaked Stripe live key is a bad day. A leaked service role key is a worse day.

### `.env.example` — the file you DO commit

Commit a template so collaborators know what to set:

```
# .env.example — committed to git, no real values
STRIPE_SECRET_KEY=sk_test_replace_me
STRIPE_WEBHOOK_SECRET=whsec_replace_me
EXPO_ACCESS_TOKEN=replace_me
PUSH_FN_SECRET=generate_with_openssl_rand_hex_32
```

New devs `cp .env.example supabase/functions/.env`, fill in real values, and they're running. This is the convention every Supabase project should follow.

## Production — `supabase secrets set`

**Set them once, they're available immediately.** No re-deploy needed — secrets propagate to running functions on the next invocation.

**Bulk from a file (recommended):**

```bash
# Create a separate prod env file — DO NOT reuse supabase/functions/.env,
# which contains test keys. This one stays local, never committed.
cat > .env.production << 'EOF'
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
EXPO_ACCESS_TOKEN=expo_prod_xxx
PUSH_FN_SECRET=$(openssl rand -hex 32)
EOF

supabase secrets set --env-file .env.production
```

**One at a time:**

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx EXPO_ACCESS_TOKEN=expo_prod_xxx
```

**Inspect what's set:**

```bash
supabase secrets list
```

Lists names only — never values. If you need to retrieve a value, you have to set it again from your records (the password manager / 1Password vault that has the original).

**Unset:**

```bash
supabase secrets unset STRIPE_WEBHOOK_SECRET
```

### Dashboard alternative

Same effect, GUI version: **Edge Functions → Secrets** in the project dashboard. Useful for one-off setup or for non-CLI users on the team. Both routes write to the same store.

## The "works locally, undefined in production" debug ladder

Whenever you hit this — and you will — walk this list in order:

1. **Did you actually run `supabase secrets set`?** Not just edit the dashboard, not just put it in `.env`. Run `supabase secrets list` to confirm the name is there.
2. **Is the name spelled identically?** `STRIPE_SECRET_KEY` vs `STRIPE_KEY` vs `STRIPESECRETKEY` — `Deno.env.get` returns `undefined` for typos with no warning. Compare the secret name in the function code, in `.env`, and in `secrets list` output character by character.
3. **Is your local `.env` loaded?** If you used a custom file name (`.env.local`, `.env.staging`), you must pass `--env-file <name>` to `supabase functions serve`. Without it, only `supabase/functions/.env` is auto-loaded.
4. **Did you redeploy the function after adding the secret?** You don't have to — secrets are runtime-injected, not bundled — but if you're seeing a wildly stale value, force a redeploy with `supabase functions deploy <name>` to rule it out.
5. **Are you reading the right project?** `supabase link --project-ref <ref>` decides which project `secrets set` writes to. If you have multiple projects (staging, prod) and recently switched, the secret may have landed in the wrong one. `supabase projects list` to check.

## Hard rules

- **Never commit `.env` files.** Add them to `.gitignore` before you put real values in them, not after.
- **Never use `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEYS`) in client code.** The Expo bundle, the React app — these are public. The service role key bypasses RLS; leaking it means anyone can read or modify any row.
- **Never prefix server-only secrets with `EXPO_PUBLIC_` or `NEXT_PUBLIC_`.** That prefix is a signal to bundlers to inline the value into the client bundle. `STRIPE_SECRET_KEY` in your Expo app's bundle ends up shipped to every user.
- **Don't reuse the same `.env` between local and prod.** Use `supabase/functions/.env` (or `.env.local`) for local with test keys; use a separate `.env.production` (also gitignored) for production deploys. Mixing them eventually means deploying live keys locally or test keys to prod.
- **Throw on missing required secrets at startup, not on first use.** A function that boots fine and then 500s mid-payment is much harder to diagnose than one that refuses to boot.
- **Don't put secrets in `config.toml`.** That file is committed. Use `secrets set` (or env-substituted references like `secret = "env(STRIPE_SECRET_KEY)"` for OAuth providers, where `STRIPE_SECRET_KEY` is itself set via `secrets set`).
- **Rotate the service role key if it ever lands in git.** Even if you force-push the commit away, assume it's compromised. Rotate from the dashboard, then `supabase secrets set` the new value if any function references it directly.
- **`supabase secrets set` takes effect immediately — no redeploy needed.** Useful to know when debugging; a slow `secrets set → invoke` cycle isn't because of caching, so look elsewhere.
- **`supabase secrets list` shows names only.** If you forget a value, you set it again from your password manager — there's no "show me the secret" command.
