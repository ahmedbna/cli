---
name: supabase-auth-expo
description: Wire Supabase Auth into Expo/RN — session persistence, auto-refresh, OAuth deep links, anonymous sign-in, and `auth.users` → `public.users` triggers.
---

# Supabase Auth on Expo / React Native

Four things must be set up explicitly — sessions don't persist, tokens silently expire in background, OAuth never returns, and `public.users` rows aren't created automatically without them.

## 1. Custom storage adapter (SecureStore)

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
      detectSessionInUrl: false, // RN is not a browser
      flowType: 'pkce',          // required for OAuth on mobile
    },
  },
);
```

**SecureStore has 2 KB value limit on iOS.** If sessions grow past that, use `@react-native-async-storage/async-storage`.

## 2. AppState foreground/background handler

JS timers pause when app backgrounds — without this, tokens silently expire and next request 401s.

```ts
// In supabase/client.ts, after createClient
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
```

Non-optional on native.

## 3. AuthProvider with `getSession()` + `onAuthStateChange`

```tsx
// hooks/useAuth.tsx
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    // Restore from SecureStore — async
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setStatus(data.session ? 'authenticated' : 'unauthenticated');
    });

    // SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, PASSWORD_RECOVERY
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setStatus(next ? 'authenticated' : 'unauthenticated');
    });

    return () => sub.subscription.unsubscribe();
  }, []);
}
```

Gate the app on `status`:

```tsx
{status === 'loading' && <Spinner />}
{status === 'unauthenticated' && <Authentication />}
{status === 'authenticated' && <Stack />}
```

**Never render protected screens while `status === 'loading'`** — RLS rejects, UI flashes errors.

## 4. Auto-create public.users on sign-up (DB trigger)

`auth.users` is GoTrue-managed and not queryable. App code uses `public.users`.

```sql
-- supabase/migrations/0004_auth_triggers.sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer            -- bypasses RLS to insert
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

**Do not** add a client-facing INSERT policy on `users`. The trigger is the only writer.

Mirror email/confirmation changes:

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

Validate password rules **client-side** before calling the SDK:

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

If `enable_confirmations = true`, sign-up creates user without session:

```ts
const { data, error } = await supabase.auth.signUp({ email, password });
if (data.user && !data.session) {
  showToast('Check your email to confirm your account.');
}
```

## Anonymous sign-in

```ts
async signInAnonymously() {
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw new ApiError(error.message, error.code, error);
},
```

```toml
# supabase/config.toml
[auth]
enable_anonymous_sign_ins = true
```

To upgrade later: `supabase.auth.updateUser({ email, password })` while anonymous session is active — same `id`, just adds credentials.

## OAuth on Expo

```ts
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { makeRedirectUri } from 'expo-auth-session';

async function signInWithGoogle() {
  const redirectTo = makeRedirectUri({ scheme: 'bna' });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('No OAuth URL returned');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return;

  const url = new URL(result.url);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('No code in OAuth callback');

  const { error: exchErr } = await supabase.auth.exchangeCodeForSession(code);
  if (exchErr) throw exchErr;
}
```

Three places must align:

| Place                                 | Value                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `app.json`                            | `"scheme": "bna"`                                                                  |
| `supabase/config.toml`                | `site_url = "bna://"` and `additional_redirect_urls = ["bna://*"]`                 |
| Provider console (Google/Apple/etc)   | Supabase callback URL: `https://<ref>.supabase.co/auth/v1/callback`                |

`flowType: 'pkce'` is required.

## Reading the current user

```ts
// In-memory — for "is signed in?" gates
const { data } = await supabase.auth.getUser();
const userId = data.user?.id;

// What 99% of screens want — the public.users profile row
const { data: profile } = await supabase
  .from('users')
  .select('*')
  .eq('id', userId)
  .maybeSingle();
```

`auth.users` ≠ `public.users`. Custom fields live on `public.users`.

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

// In a screen
const { data: user, isLoading } = useQuery({
  queryKey: ['auth', 'me'],
  queryFn: api.auth.loggedInUser,
});
```

Invalidate `['auth', 'me']` after profile updates.

## Hard rules

- **Don't** call `createClient` in more than one place. UI imports `@/supabase/api`, never `@/supabase/client`.
- **Don't** add an INSERT policy on `public.users`. The trigger is the only writer.
- **Don't** use `getUser()` (network round-trip) for "am I logged in" — read the session.
- **Don't** trust client about `is_anonymous`. RLS uses `auth.uid()` / `auth.jwt()` server-side.
- **Don't** call `supabase.auth` from UI. Funnel through `supabase/api/auth.ts`.
- **Don't** forget `detectSessionInUrl: false`.
- **Don't** ship `enable_confirmations = false` to prod.

## Setup checklist

1. `supabase/client.ts`: SecureStore adapter + AppState handler + `flowType: 'pkce'`.
2. Migration with `public.users` + `handle_new_user` + `handle_user_email_change` triggers.
3. RLS on `users` with `select_self`, `select_authed`, `update_self`, `delete_self` policies (no INSERT).
4. `AuthProvider` with `loading | authenticated | unauthenticated` and root gate.
5. `supabase/api/auth.ts` for all auth calls.
6. OAuth: `app.json` scheme + `config.toml` redirects + provider console callback all aligned.
