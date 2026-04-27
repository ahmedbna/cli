---
name: supabase-auth-expo
description: Use when wiring Supabase Auth into an Expo / React Native app — session persistence, auto-refresh, OAuth deep links, anonymous sign-in, password rules, or syncing auth.users to a public.users profile row. Trigger on "supabase auth", "signIn", "signUp", "signInWithOAuth", "signInAnonymously", "session", "AsyncStorage", "SecureStore", "auth state", "onAuthStateChange", "expo-auth-session", "deep link", "redirect", "auth.users", "handle_new_user", or any auth flow that has to work on iOS/Android (not the browser).
---

# Supabase Auth on Expo / React Native

Supabase Auth ships as a browser-first SDK. Naively dropping it into Expo gives you four bugs in a row: sessions don't persist, tokens silently expire in the background, OAuth never returns, and `public.users` rows are never created. Fix all four explicitly.

## The four things that must be set up — in order

### 1. Custom storage adapter (SecureStore on native, default on web)

Without a storage adapter, sessions don't survive app restarts. The default browser adapter (`localStorage`) doesn't exist in RN.

```ts
// supabase/client.ts
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import type { Database } from './types';

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient<Database>(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      storage: ExpoSecureStoreAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // RN is not a browser — must be false
      flowType: 'pkce',          // required for OAuth on mobile
    },
  },
);
```

**SecureStore has a 2 KB value limit on iOS.** Supabase's session blob is well under that today, but if you ever stuff custom data into `user_metadata` and tokens grow, swap in `@react-native-async-storage/async-storage` instead — it has no size cap.

### 2. AppState foreground/background handler

Without this, `autoRefreshToken: true` does nothing useful on mobile. JS timers are paused when the app backgrounds, so a 1-hour token quietly expires while the user is away and the next request 401s.

```ts
// In supabase/client.ts, after createClient
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
```

This is non-optional on native. Add it once, at module scope, in the same file as `createClient`.

### 3. AuthProvider with `getSession()` + `onAuthStateChange`

Render-blocking on a stale `null` session is the most common bug. Always show a loading state until `getSession()` resolves the SecureStore-restored session.

```tsx
// hooks/useAuth.tsx
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    // Restore from SecureStore — async, so we start in 'loading'.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setStatus(data.session ? 'authenticated' : 'unauthenticated');
    });

    // Subscribe to every auth event: SIGNED_IN, SIGNED_OUT,
    // TOKEN_REFRESHED, USER_UPDATED, PASSWORD_RECOVERY.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setStatus(next ? 'authenticated' : 'unauthenticated');
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // ... expose status, session, signIn, signUp, signOut via context
}
```

Gate the entire app on `status`:

```tsx
{status === 'loading' && <Spinner />}
{status === 'unauthenticated' && <Authentication />}
{status === 'authenticated' && <Stack />}
```

Never render protected screens while `status === 'loading'` — RLS will reject the queries, the UI flashes errors, and TanStack Query caches the failures.

### 4. Auto-create public.users on sign-up (database trigger)

`auth.users` is managed by GoTrue and is **not** queryable by the client. Your app code talks to `public.users`. Without a trigger, sign-up creates an auth row with no matching profile row — every `select` returns null.

```sql
-- supabase/migrations/0004_auth_triggers.sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer            -- must bypass RLS to insert
set search_path = public
as $$
declare
  _is_anon boolean;
begin
  _is_anon := coalesce(
    (new.raw_app_meta_data ->> 'provider') = 'anonymous',
    false
  );

  insert into public.users (id, email, is_anonymous)
  values (new.id, new.email, _is_anon)
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

`security definer` is required — the trigger runs as the table owner, not the anon role, so it can insert into `public.users` even though there's no INSERT policy. **Do not** add a client-facing INSERT policy on `users`; that's a footgun. The trigger is the only way profile rows get created.

Mirror email/`email_confirmed_at` changes too:

```sql
create or replace function public.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.users
      set email = new.email,
          email_verification_time = extract(epoch from new.email_confirmed_at) * 1000
      where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_updated
  after update on auth.users
  for each row execute function public.handle_user_email_change();
```

## Email + password sign-up

Always validate password rules **client-side** before calling the SDK. GoTrue's default error messages are unhelpful (`"Password should be at least 6 characters"` regardless of which rule failed).

```ts
// supabase/api/auth.ts
function validatePasswordRequirements(password: string): void {
  if (!password || password.length < 8) throw new ApiError('Password must be at least 8 characters long');
  if (!/\d/.test(password))            throw new ApiError('Password must contain at least one number');
  if (!/[a-z]/.test(password))         throw new ApiError('Password must contain at least one lowercase letter');
  if (!/[A-Z]/.test(password))         throw new ApiError('Password must contain at least one uppercase letter');
}

export const auth = {
  async signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new ApiError(error.message, error.code, error);
  },

  async signUp(email: string, password: string) {
    validatePasswordRequirements(password);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw new ApiError(error.message, error.code, error);
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw new ApiError(error.message, error.code, error);
  },
};
```

If `enable_confirmations = true` in `config.toml`, `signUp` returns success but the user can't sign in until they click the email link. Tell the user explicitly:

```ts
const { data, error } = await supabase.auth.signUp({ email, password });
if (data.user && !data.session) {
  // confirmation email was sent — no session yet
  showToast('Check your email to confirm your account.');
}
```

## Anonymous sign-in (guest mode)

```ts
async signInAnonymously() {
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw new ApiError(error.message, error.code, error);
},
```

Enable it in `supabase/config.toml`:

```toml
[auth]
enable_anonymous_sign_ins = true
```

Anonymous users get a real `auth.users` row with `is_anonymous = true` (readable from `raw_app_meta_data.provider === 'anonymous'`). The trigger above already handles this. To later "upgrade" them to a real account, call `supabase.auth.updateUser({ email, password })` while the anonymous session is still active — same `auth.users` row, same `id`, just gets an email/password attached.

**Don't gate read-only screens behind anonymous sign-in.** The whole point is frictionless onboarding. Make sign-in reactive: if a guest tries to do something that requires a "real" user (e.g. invite a friend), prompt for email there.

## OAuth on Expo (Google / Apple / GitHub)

The browser flow doesn't work on native. You **must** use `expo-web-browser` + `expo-auth-session` and hand the resulting code back to Supabase.

```ts
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';

async function signInWithGoogle() {
  const redirectTo = makeRedirectUri({ scheme: 'bna' }); // matches app.json "scheme"

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('No OAuth URL returned');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return; // user cancelled

  // result.url looks like: bna://auth?code=abc123
  const url = new URL(result.url);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No code in OAuth callback');

  const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
  if (exchErr) throw exchErr;
}
```

Three things must line up or this fails silently:

| Place | Value | Notes |
| ----- | ----- | ----- |
| `app.json` | `"scheme": "bna"` | Lowercase, no special chars. |
| `supabase/config.toml` | `site_url = "bna://"` and `additional_redirect_urls = ["bna://*"]` | Both required. |
| Provider console (Google/Apple/GitHub) | Add the Supabase callback URL: `https://<ref>.supabase.co/auth/v1/callback` | Not the `bna://` URL. |

The provider redirects to Supabase, Supabase redirects to `bna://`, Expo opens your app. If any link in the chain is wrong, you sit on the OAuth screen forever.

`flowType: 'pkce'` is required in `createClient` — implicit flow doesn't work with `expo-auth-session`.

## Reading the current user

Two distinct things — don't confuse them:

```ts
// Cheap, synchronous-feeling — reads from in-memory session.
// Use this for "is the user signed in?" gates.
const { data } = await supabase.auth.getUser();
const userId = data.user?.id;

// What 99% of screens actually want — the public.users profile row.
const { data: profile } = await supabase
  .from('users')
  .select('*')
  .eq('id', userId)
  .maybeSingle();
```

`auth.users` ≠ `public.users`. The auth row has `id`, `email`, `phone`, `app_metadata`, `user_metadata`, and that's it. Custom fields (`name`, `bio`, `birthday`, etc.) live on `public.users`. Always join via `id`.

Wrap this in a `loggedInUser()` helper and let TanStack Query handle reactivity:

```ts
// supabase/api/auth.ts
async loggedInUser(): Promise<User | null> {
  const userId = await getUserIdOrNull();
  if (!userId) return null;
  const { data, error } = await supabase
    .from('users').select('*').eq('id', userId).maybeSingle();
  if (error) throw new ApiError(error.message, error.code, error);
  return data;
}

// In a screen:
const { data: user, isLoading } = useQuery({
  queryKey: ['auth', 'me'],
  queryFn: api.auth.loggedInUser,
});
```

Invalidate `['auth', 'me']` after profile updates so the cache refreshes.

## Hard rules

- **Don't** call `createClient` in more than one place. UI imports `@/supabase/api`, never `@/supabase/client`.
- **Don't** add an INSERT policy on `public.users`. The trigger is the only authorized writer.
- **Don't** use `getUser()` everywhere instead of `getSession()` — `getUser()` makes a network round-trip. For "am I logged in" checks, read the session.
- **Don't** trust the client about `is_anonymous`. RLS checks against `auth.uid()` and `auth.jwt()` — always derive identity server-side.
- **Don't** call `supabase.auth` from UI components. Funnel everything through `supabase/api/auth.ts` so error handling and password rules are centralized.
- **Don't** forget `detectSessionInUrl: false`. With it on, Supabase tries to parse the URL on every cold start in RN and logs warnings.
- **Don't** ship `enable_confirmations = false` to production. It's only for local dev. Flip it before launch and verify the email template works.

## Quick checklist for a new app

1. `supabase/client.ts`: SecureStore adapter + AppState handler + `flowType: 'pkce'`.
2. Migration with `public.users` table + `handle_new_user` trigger + matching `handle_user_email_change` trigger.
3. RLS enabled on `users` with `select_self`, `select_authed`, `update_self`, `delete_self` policies (no INSERT).
4. `AuthProvider` with `loading | authenticated | unauthenticated` status and root-level gate.
5. `supabase/api/auth.ts` exporting `signIn`, `signUp`, `signInAnonymously`, `signOut`, `loggedInUser`. UI never touches `supabase.auth`.
6. For OAuth: `app.json` scheme + `config.toml` redirect URLs + provider console callback all aligned.