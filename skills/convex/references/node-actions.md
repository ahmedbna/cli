# Convex Node.js Actions

Actions that need Node.js built-ins (fetch, crypto, fs, etc.) or npm packages.

```ts
"use node"; // MUST be the first line of the file

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

export const generate = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }) => {
    // No ctx.db in actions — use ctx.runQuery / ctx.runMutation
    const history = await ctx.runQuery(internal.messages.list, {});

    // External API call (e.g., OpenAI)
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.choices[0].message.content;

    // Save result via mutation
    await ctx.runMutation(internal.messages.save, { text });
    return text;
  },
});
```

## Rules

- `"use node";` MUST be the first line — no imports before it
- No `ctx.db` access — use `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`
- Env vars: `process.env.MY_KEY` — set via Convex dashboard or `npx convex env set`
- Actions have a 10-minute timeout (vs 1s for queries/mutations)
- Use `internal` references for functions called from within actions
- Actions are NOT automatically retried on failure
