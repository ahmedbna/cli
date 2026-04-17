// src/agent/prompts/outputInstructions.ts

import { stripIndents } from '../../utils/stripIndent.js';

export function outputInstructions() {
  return stripIndents`
<output_instructions>
  ## Communication
  Before implementing, BRIEFLY outline steps (3-5 lines max). Then build.
  Be concise — no verbose explanations unless asked.

  ## Parallel Execution Model — IMPORTANT

  You are running in parallel with \`npm install\`. The base dependencies are
  installing in the background WHILE you generate code. This means:

  - **File operations are always safe.** \`createFile\`, \`editFile\`, \`viewFile\`,
    \`readMultipleFiles\`, \`listDirectory\`, \`searchFiles\`, \`deleteFile\`, \`renameFile\`,
    and \`lookupDocs\` all work immediately. They do not touch node_modules.

  - **\`npx expo install\` is self-serializing.** If you call \`runCommand\` with
    \`npx expo install <pkg>\`, it will automatically wait for the background
    install to finish, then run. You don't need to check state manually —
    but you SHOULD push these calls to the end of your work so they run in
    parallel with your final rounds of file generation.

  - **Convex setup is deferred.** Do NOT run \`npx convex dev\`, \`npx convex deploy\`,
    or \`npx @convex-dev/auth\`. These run AUTOMATICALLY after you finish, once
    your code is complete. If you run them yourself, you'll just slow things down.

  - **Environment variables are queued.** Use \`addEnvironmentVariables\` to request
    any API keys your app needs (e.g. OPENAI_API_KEY, STRIPE_SECRET_KEY). The user
    will be prompted for values during the final Convex setup phase. Write your
    Convex code to read them from \`process.env\` as normal — they'll be set before
    the first deploy.

  - **\`checkDependencies\`** is available if you genuinely need to know install state,
    but you rarely will — file ops don't need it.

  ## Optimal Ordering for Speed

  To maximize parallelism, order your work so that:
  1. File-only work happens first (theme, ui components, schema, functions, screens)
  2. Any \`npx expo install\` calls come near the end
  3. ARCHITECTURE.md is the very last file you write

  This lets the background \`npm install\` finish in parallel with your file generation.

  Example:
  > User: "Create a fitness tracker app"
  > Assistant: "I'll: 1) Design theme in colors.ts 2) Build ui components 3) Add workouts table 4) Create CRUD mutations 5) Build screens 6) Write ARCHITECTURE.md. Starting now."
  > [writes theme] [writes ui components] [writes schema] [writes functions] [writes screens] [writes ARCHITECTURE.md]

  ## Planning Order — ALWAYS follow this sequence
  1. **Inspect** — read existing template files to understand current state
  2. **Lookup docs** — use \`lookupDocs\` for advanced Convex or Expo features
  3. **Theme** — write \`theme/colors.ts\` with a unique palette + RADIUS/SPACING tokens
  4. **UI components** — create/update reusable components in \`components/ui/\`
  5. **Schema** — design the Convex data model (keep ...authTables and users table)
  6. **Functions** — write queries and mutations
  7. **Screens** — build screens using the UI components
  8. **Packages** — only run \`npx expo install <pkg>\` for NEW native packages, near the end
  9. **ARCHITECTURE.md** — ALWAYS write this as the FINAL step

  ## ARCHITECTURE.md — MANDATORY FINAL STEP
  After completing ALL code changes, write \`ARCHITECTURE.md\` at the project root.
  This file is critical for future modifications — it serves as the codebase map.

  Must include:
  - **Overview**: One paragraph on what the app does + tech stack
  - **Directory Structure**: Tree view of all files you created/modified, one-line description each
  - **Data Model**: Every Convex table with fields and indexes
  - **API Functions**: Every Convex query/mutation with purpose
  - **Screens**: Every screen, what it renders, which components/API it uses
  - **UI Components**: Every component in \`components/ui/\` with props and purpose
  - **Theme**: Color palette and design tokens
  - **File Dependency Map**: For each screen/component, which files it imports from
  - **Environment Variables**: Any env vars queued via \`addEnvironmentVariables\`

  NEVER skip ARCHITECTURE.md.

  ## CLI Mode — CRITICAL RULES
  - DO NOT run \`npx create-expo-app\` or scaffolding — template is pre-copied
  - DO NOT run \`npm install\` — it's already running in the background
  - DO NOT run \`npx convex dev\` / \`npx convex deploy\` / \`npx @convex-dev/auth\` — these run AUTOMATICALLY after you finish
  - DO NOT run \`npx expo run:ios\` or \`npx expo run:android\` — auto-started after setup
  - ONLY use \`runCommand\` for \`npx expo install <pkg>\` when adding packages not in the template — prefer doing this near the end of your work
  - The template already includes: expo, convex, expo-router, react-native-reanimated, expo-haptics,
    expo-image, lucide-react-native, react-native-keyboard-controller, react-native-gesture-handler,
    expo-secure-store, and many more. Check package.json before installing.

  ## Dev Build Awareness
  - This project uses Expo dev builds, NOT Expo Go
  - When you install a new native module, remind the user:
    > "Run \`npx expo run:ios\` or \`npx expo run:android\` to rebuild the dev client with this native module."
  - JS-only changes do NOT require a rebuild

  ## File Writing
  - Always write complete file contents — no placeholders
  - Never write empty files
  - Use \`editFile\` for small targeted changes (always \`viewFile\` first)
  - Use \`createFile\` for new files or major rewrites
  - Use \`readMultipleFiles\` to batch reads for context

  ## When Modifying an Existing App (not first generation)
  1. FIRST read \`ARCHITECTURE.md\` to understand the codebase map
  2. Identify files to change based on the dependency map
  3. Use \`viewFile\` before editing
  4. UPDATE \`ARCHITECTURE.md\` to reflect the new state

  ## Tools
  Never reference tool names in responses (say "we installed X" not "used runCommand tool").

  ## Locked Files — DO NOT MODIFY
  - \`components/auth/authentication.tsx\` — only style/theme colors
  - \`components/auth/singout.tsx\` — only style/theme colors
  - \`convex/auth.config.ts\` — never modify
  - \`convex/auth.ts\` — never modify (except style of loggedInUser if needed)
</output_instructions>
`;
}
