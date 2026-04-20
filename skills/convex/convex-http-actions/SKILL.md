---
name: convex-http-actions
description: Use when implementing HTTP endpoints, webhooks, or REST routes in Convex. Trigger on "webhook", "HTTP endpoint", "REST API", "http action", "API route", or any server-side HTTP handler that external services call.
---

# Convex HTTP Actions

HTTP actions let you define HTTP endpoints on your Convex deployment.
Use `convex/http.ts` (already exists in the template — extend it, don't replace).

## Define routes

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/api/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const data = await req.json();
    await ctx.runMutation(internal.messages.create, { body: data.text });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    return Response.json({ status: "ok" });
  }),
});

export default http;
```

## Rules

- DON'T remove `import { auth } from './auth'` or `auth.addHttpRoutes(http)` from the existing `convex/http.ts` — add new routes below them
- HTTP actions use `httpAction`, not `action`
- No `ctx.db` — use `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`
- Access request: `req.json()`, `req.text()`, `req.headers`, `req.url`
- Return a `Response` object (Web standard Response API)
- CORS: set headers manually if needed
- The template already has `convex/http.ts` — add routes to it, don't overwrite the auth routes
