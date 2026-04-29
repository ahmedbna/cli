---
name: convex-http-actions
description: Define HTTP endpoints in Convex for webhooks, REST routes, and external integrations. Routes live at `.convex.site` (not `.cloud`).
---

# Convex HTTP Actions

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

export default http;
```

## Where HTTP actions live

HTTP actions live at `https://<deployment>.convex.site` (note `.site`, **not** `.cloud`).

To call from a browser, derive the `.site` URL from `EXPO_PUBLIC_CONVEX_URL`:

```ts
const convexDeploymentUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
const convexSiteUrl = convexDeploymentUrl.endsWith('.cloud')
  ? convexDeploymentUrl.slice(0, -'.cloud'.length) + '.site'
  : convexDeploymentUrl;
```

## Calling from curl

```bash
curl -d '{ "author": "User 123", "body": "Hello world" }' \
  -H 'content-type: application/json' \
  https://<deployment>.convex.site/postMessage

curl https://<deployment>.convex.site/getMessagesByAuthor?authorNumber=123
```

## Calling from React Native

```tsx
import { useMemo } from 'react';

const convexSiteUrl = useMemo(() => {
  const deploymentUrl = process.env.EXPO_PUBLIC_CONVEX_URL ?? '';
  return deploymentUrl.endsWith('.cloud')
    ? deploymentUrl.slice(0, -'.cloud'.length) + '.site'
    : deploymentUrl;
}, []);

await fetch(`${convexSiteUrl}/postMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ author: name, body: text }),
});
```

In RN, the only way to reach an HTTP action is `fetch`. Use `TextInput`'s `onChangeText` and trigger from `onPress`/`onSubmitEditing`.

### When to use which

- **Convex client SDK** — preferred for in-app data. Reactive, typed, auth-integrated.
- **HTTP actions + `fetch`** — required for webhooks (Stripe, Clerk, GitHub), public REST APIs, non-JS clients, or RN contexts where the Convex provider isn't mounted (background tasks, push handlers, share extensions).

## CORS

For browser-origin callers, set headers yourself and handle the `OPTIONS` preflight. Pin allowed origin via env var:

```ts
http.route({
  path: '/sendImage',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const blob = await request.blob();
    const storageId = await ctx.storage.store(blob);

    const author = new URL(request.url).searchParams.get('author');
    if (!author) return new Response('Author is required', { status: 400 });

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
```

CORS notes:
- One `OPTIONS` route per `path`. Mirror methods/headers you accept.
- Always include `Vary: origin` so caches don't serve the wrong reply.
- React Native `fetch` is not subject to CORS. Webhooks (server-to-server) also don't need it.

## Authentication

Caller passes JWT in `Authorization: Bearer <token>`. Read with `ctx.auth.getUserIdentity()`:

```ts
http.route({
  path: '/myAction',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return new Response('Unauthorized', { status: 401 });
    }
    return Response.json({ userId: identity.subject });
  }),
});
```

From RN, grab the JWT and forward it:

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

When CORS is in play, add `Authorization` to `Access-Control-Allow-Headers` in `OPTIONS`.

## Rules

- DON'T remove `import { auth } from './auth'` or `auth.addHttpRoutes(http)` from existing `convex/http.ts` — add new routes below.
- Use `httpAction`, not `action`.
- No `ctx.db` — use `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`.
- Standard Web Request API: `req.json()`, `req.text()`, `req.headers`, `new URL(req.url).searchParams`.
- Return a standard `Response` (`Response.json(...)`, `new Response(...)`).
- Host split: `.cloud` for the SDK, `.site` for HTTP actions.
