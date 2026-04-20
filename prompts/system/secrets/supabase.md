## Secrets

When your app needs API keys or secrets:

1. Call `addEnvironmentVariables` with the exact env var name(s) (e.g. `OPENAI_API_KEY`).
   This queues them — you don't wait, just continue building.
2. Write your server code to read them from `process.env.<VAR_NAME>` as normal.
3. The CLI will prompt the user for values during the final Supabase setup phase, BEFORE the first deploy, so the values are available at runtime.

Do NOT:
- Instruct the user mid-generation to go set env vars — the CLI handles this at the end
- Block your own progress waiting for confirmation
- Hardcode placeholder values in your code

Just queue, continue, and reference via process.env.
