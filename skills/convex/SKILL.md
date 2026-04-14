---
name: convex-docs
description: Use this skill before implementing advanced Convex features beyond basic CRUD. Trigger when the agent needs to write code for file storage, full-text search, pagination, HTTP actions/webhooks, cron jobs, scheduled functions, Node.js actions (external API calls), TypeScript types, cross-function calling, advanced queries, advanced mutations, or real-time presence. Always read the relevant reference doc BEFORE writing implementation code.
---

# Convex Advanced Features Reference

This skill provides documentation for Convex features beyond basic CRUD operations.
The agent MUST read the relevant reference file before implementing any of these features
to avoid common mistakes and follow best practices.

## Available Topics

| Topic | File | When to read |
|-------|------|-------------|
| File Storage | `references/file-storage.md` | Upload/download files, store images, handle media |
| Full-Text Search | `references/full-text-search.md` | Search indexes, text search queries |
| Pagination | `references/pagination.md` | Paginated queries, infinite scroll, load more |
| HTTP Actions | `references/http-actions.md` | Webhooks, REST endpoints, HTTP routes |
| Scheduling | `references/scheduling.md` | Cron jobs, delayed execution, scheduled functions |
| Node.js Actions | `references/node-actions.md` | External API calls, `"use node"`, fetch, crypto |
| TypeScript Types | `references/types.md` | Doc types, Id types, function return types, Infer |
| Function Calling | `references/function-calling.md` | Cross-context calls, api vs internal refs |
| Advanced Queries | `references/advanced-queries.md` | Compound indexes, ordering, filtering, conditional queries |
| Advanced Mutations | `references/advanced-mutations.md` | Batch insert, upsert, cascade delete, patch vs replace |
| Presence | `references/presence.md` | Real-time user presence, online indicators |

## Usage Pattern

1. Identify which advanced feature the app needs
2. Read the corresponding reference file with `viewFile`
3. Follow the patterns exactly — Convex has strict conventions
4. Key rules that apply to ALL Convex code:
   - NEVER use `.filter()` — always use `.withIndex()`
   - NEVER use return validators
   - ALWAYS include arg validators
   - Actions have NO `ctx.db` — use `ctx.runQuery`/`ctx.runMutation`
   - `"use node"` MUST be the first line in Node.js action files
