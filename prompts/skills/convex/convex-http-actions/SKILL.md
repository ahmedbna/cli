---
name: convex-http-actions
description: Use when implementing HTTP endpoints, webhooks, or REST routes in Convex. Trigger on "webhook", "HTTP endpoint", "REST API", "http action", "API route", or any server-side HTTP handler that external services call.
---

# Convex HTTP Actions

HTTP actions let you define HTTP endpoints on your Convex deployment. They're useful for webhooks, REST APIs, and any case where an external service (or your own client) needs to hit a URL rather than use the Convex client SDK.

Use `convex/http.ts` (already exists in the template — extend it, don't replace).

## Define routes

```ts
// convex/http.ts
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';

const http = httpRouter();

http.route({
  path: '/postMessage',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const { author, body } = await req.json();
    await ctx.runMutation(internal.messages.create, { author, body });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: '/getMessagesByAuthor',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const authorNumber = url.searchParams.get('authorNumber');
    const messages = await ctx.runQuery(internal.messages.byAuthor, {
      authorNumber,
    });
    return Response.json(messages);
  }),
});

http.route({
  path: '/api/health',
  method: 'GET',
  handler: httpAction(async () => {
    return Response.json({ status: 'ok' });
  }),
});

export default http;
```

## Where HTTP actions are exposed

HTTP actions live at `https://<your deployment name>.convex.site` (note `.site`, **not** `.cloud`).

The standard `EXPO_PUBLIC_CONVEX_URL` env var points at the `.cloud` domain used by the Convex client SDK. To call HTTP actions from the browser, derive the `.site` URL from it:

```ts
const convexDeploymentUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const convexSiteUrl = convexDeploymentUrl.endsWith('.cloud')
  ? convexDeploymentUrl.slice(0, -'.cloud'.length) + '.site'
  : convexDeploymentUrl;
```

## Calling HTTP actions

### From `curl` (external services, webhooks, testing)

```bash
# POST
curl -d '{ "author": "User 123", "body": "Hello world" }' \
  -H 'content-type: application/json' \
  https://<your deployment name>.convex.site/postMessage

# GET with query params
curl https://<your deployment name>.convex.site/getMessagesByAuthor?authorNumber=123
```

### From Expo React Native client

```tsx
import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
} from 'react-native';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../convex/_generated/api';

export default function ChatScreen() {
  const messages = useQuery(api.messages.list) ?? [];
  const sendMessage = useMutation(api.messages.send);
  const [newMessageText, setNewMessageText] = useState('');
  const [name] = useState(() => 'User ' + Math.floor(Math.random() * 10000));

  // Derive the .site URL for HTTP actions from the SDK's .cloud URL
  const convexSiteUrl = useMemo(() => {
    const deploymentUrl = process.env.EXPO_PUBLIC_CONVEX_URL ?? '';
    return deploymentUrl.endsWith('.cloud')
      ? deploymentUrl.slice(0, -'.cloud'.length) + '.site'
      : deploymentUrl;
  }, []);

  // Send via the typed Convex client (preferred for in-app traffic)
  async function handleSend() {
    if (!newMessageText.trim()) return;
    await sendMessage({ body: newMessageText, author: name });
    setNewMessageText('');
  }

  // Same write, but going through an HTTP action — useful from non-Convex
  // contexts (background tasks, share extensions, server code, etc.)
  async function postViaHttp() {
    await fetch(`${convexSiteUrl}/postMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: name, body: newMessageText }),
    });
  }

  return (
    <View>
      <Text>Convex Chat</Text>
      <Text>{name}</Text>

      <FlatList
        data={messages}
        keyExtractor={(m) => m._id}
        renderItem={({ item }) => (
          <View>
            <Text>{item.author}</Text>
            <Text>{item.body}</Text>
            <Text>{new Date(item._creationTime).toLocaleTimeString()}</Text>
          </View>
        )}
        contentContainerStyle={{ paddingVertical: 8 }}
      />

      <View>
        <TextInput
          value={newMessageText}
          onChangeText={setNewMessageText}
          placeholder='Write a message…'
          returnKeyType='send'
          onSubmitEditing={handleSend}
        />
        <Pressable
          onPress={handleSend}
          disabled={!newMessageText.trim()}
          style={({ pressed }) => [
            (!newMessageText.trim() || pressed) && { opacity: 0.5 },
          ]}
        >
          <Text>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
```

> Important: in React Native the only way to reach an HTTP action is `fetch` (or a library like `axios`). There is no `<form>`, no `event.target.value`, no DOM. Use `TextInput`'s `onChangeText` (not `onChange`), and trigger requests from `onPress` / `onSubmitEditing` handlers.

### When to use which

- **Convex client SDK (`useQuery` / `useMutation`)** — preferred for in-app data flow inside your Expo React Native app. Reactive, typed, auth-integrated.
- **HTTP actions + `fetch`** — required for webhooks (Stripe, Clerk, GitHub, etc.), third-party integrations, public REST APIs, non-JS clients, or RN contexts where the Convex provider isn't mounted (background tasks, push-notification handlers, share extensions).

## CORS

When the route is called from a browser on a different origin (e.g. a marketing site, a Stripe-hosted checkout return page) you must set CORS headers yourself — Convex does not add them. Add `Access-Control-Allow-Origin` to every response **and** handle the preflight `OPTIONS` request as a separate route.

Pin the allowed origin via an env var (set with `npx convex env set CLIENT_ORIGIN https://mysite.com`) so dev and prod can differ:

```ts
// convex/http.ts
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { api } from './_generated/api';

const http = httpRouter();

http.route({
  path: '/sendImage',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const blob = await request.blob();
    const storageId = await ctx.storage.store(blob);

    const author = new URL(request.url).searchParams.get('author');
    if (author === null) {
      return new Response('Author is required', { status: 400 });
    }

    await ctx.runMutation(api.messages.sendImage, { storageId, author });

    return new Response(null, {
      status: 200,
      headers: new Headers({
        'Access-Control-Allow-Origin': process.env.CLIENT_ORIGIN!,
        Vary: 'origin',
      }),
    });
  }),
});

// Preflight (browsers send this before any non-simple request)
http.route({
  path: '/sendImage',
  method: 'OPTIONS',
  handler: httpAction(async (_, request) => {
    const headers = request.headers;
    if (
      headers.get('Origin') !== null &&
      headers.get('Access-Control-Request-Method') !== null &&
      headers.get('Access-Control-Request-Headers') !== null
    ) {
      return new Response(null, {
        headers: new Headers({
          'Access-Control-Allow-Origin': process.env.CLIENT_ORIGIN!,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, Digest',
          'Access-Control-Max-Age': '86400',
        }),
      });
    }
    return new Response();
  }),
});

export default http;
```

CORS notes:

- One `OPTIONS` route per `path` you want to expose. Mirror the methods/headers you actually accept.
- Always include `Vary: origin` on real responses so caches don't serve the wrong origin's reply.
- The Expo React Native client does not need CORS — RN's `fetch` is not subject to the browser same-origin policy. CORS only matters for browser callers.
- Webhooks (Stripe, GitHub, etc.) are server-to-server, also no CORS needed.

## Authentication

HTTP actions can read the calling user's identity through Convex's built-in auth, just like queries/mutations. The caller must pass a JWT in the `Authorization: Bearer <token>` header — Convex parses it, and `ctx.auth.getUserIdentity()` returns `null` for unauthenticated requests or the identity object otherwise.

In the route:

```ts
http.route({
  path: '/myAction',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return new Response('Unauthorized', { status: 401 });
    }
    // identity.subject, identity.email, identity.tokenIdentifier, …
    return Response.json({ userId: identity.subject });
  }),
});
```

From an Expo React Native client, grab the JWT from your auth provider (e.g. `useAuthToken()` from `@convex-dev/auth/react`) and forward it:

```ts
import { useAuthToken } from '@convex-dev/auth/react';

const token = useAuthToken();

await fetch(`${convexSiteUrl}/myAction`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ /* … */ }),
});
```

When CORS is also in play, add `Authorization` to `Access-Control-Allow-Headers` in the matching `OPTIONS` route.

## Rules

- DON'T remove `import { auth } from './auth'` or `auth.addHttpRoutes(http)` from the existing `convex/http.ts` — add new routes below them.
- HTTP actions use `httpAction`, not `action`.
- No `ctx.db` inside `httpAction` — use `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`.
- Access the request via the standard Web Request API: `req.json()`, `req.text()`, `req.headers`, `req.url`. For query params, parse with `new URL(req.url).searchParams`.
- Return a standard `Response` (e.g. `Response.json(...)`, `new Response(...)`).
- For browser-origin callers, see the CORS section above (preflight + headers). RN clients and webhooks don't need CORS.
- For authenticated callers, forward the JWT via `Authorization: Bearer <token>` and read it with `ctx.auth.getUserIdentity()`.
- Remember the host split: `.cloud` for the client SDK, `.site` for HTTP actions.
- The template already has `convex/http.ts` — add routes to it, don't overwrite the auth routes.
