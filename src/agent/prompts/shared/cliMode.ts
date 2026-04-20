import { generateSkillsSummary } from '../../skills.js';
import type {
  PromptBackend,
  PromptFrontend,
  StackId,
} from '../../prompts.js';

interface CliContext {
  stack: StackId;
  frontend: PromptFrontend;
  backend: PromptBackend;
}

function afterYouFinishSection(ctx: CliContext): string {
  const lines: string[] = [];
  if (ctx.backend === 'convex') {
    lines.push(
      '- `npx convex dev` / `npx convex deploy` — auto-run after code generation',
    );
    lines.push('- `npx @convex-dev/auth` — auto-run after code generation');
    lines.push('- Setting environment variables — user prompted interactively');
  }
  if (ctx.backend === 'supabase') {
    lines.push('- `supabase db push` / migrations — auto-run after code generation');
    lines.push('- Setting environment variables — user prompted interactively');
  }
  if (ctx.frontend === 'expo') {
    lines.push('- `npx expo run:ios` / `npx expo run:android` — auto-started');
  }
  return lines.join('\n');
}

function doNotDoSection(ctx: CliContext): string {
  const lines: string[] = [];
  if (ctx.frontend === 'expo') {
    lines.push('- Run `npx create-expo-app` or any scaffolding command');
  }
  lines.push("- Run `npm install` — it's already running in the background");
  if (ctx.backend === 'convex') {
    lines.push('- Run `npx convex dev` — deferred to after your work');
  }
  if (ctx.frontend === 'expo') {
    lines.push(
      '- Run `npx expo run:ios` or `npx expo run:android` — auto-started later',
    );
  }
  return lines.join('\n');
}

function packageInstallHint(ctx: CliContext): string {
  if (ctx.frontend === 'expo') {
    return `- Use \`runCommand\` ONLY for \`npx expo install <pkg>\` when adding packages NOT in the template —
  these calls automatically wait for the base install to finish, so they're safe at any time.
  Tip: put them NEAR THE END of your work so they parallelize with your final file writes.`;
  }
  return `- Use \`runCommand\` ONLY for adding new native dependencies — push these near the end of your work so they parallelize with final file writes.`;
}

function envVarHint(ctx: CliContext): string {
  if (ctx.backend) {
    return '- Use `addEnvironmentVariables` to QUEUE env vars — user will be prompted during final setup';
  }
  return '';
}

function workflowSteps(ctx: CliContext): string {
  const steps: string[] = [
    '1. Read existing template files',
    '2. Lookup docs for advanced features',
    '3. Design theme (colors.ts)',
    '4. Build/update UI components',
  ];
  if (ctx.backend === 'convex') {
    steps.push('5. Add tables to Convex schema');
    steps.push('6. Write Convex functions');
  } else if (ctx.backend === 'supabase') {
    steps.push('5. Add tables to Supabase schema/migrations');
    steps.push('6. Write Supabase queries/RPCs/edge functions');
  } else {
    steps.push('5. Design local data model');
    steps.push('6. Wire data access layer');
  }
  steps.push('7. Build/update screens');
  if (ctx.frontend === 'expo') {
    steps.push('8. If new native packages are needed, install them NEAR THE END');
  }
  if (ctx.backend) {
    steps.push('9. If env vars are needed, queue them via `addEnvironmentVariables`');
  }
  steps.push('10. Write ARCHITECTURE.md as the FINAL step');
  return steps.join('\n');
}

function parallelNotice(ctx: CliContext): string {
  const lines: string[] = [
    'The project template has been copied and `npm install` is running IN THE BACKGROUND while you generate code.',
    'You do NOT need to wait for it. Start writing files immediately.',
    '- File operations (createFile, editFile, viewFile, etc.) work immediately and do not need dependencies.',
  ];
  if (ctx.frontend === 'expo') {
    lines.push(
      "- If you call `runCommand` for `npx expo install <pkg>`, it will automatically wait for the background install to finish and then run. You don't need to check — just call it when you need it, ideally near the end of your work so it runs in parallel with the rest of your file generation.",
    );
  }
  if (ctx.backend === 'convex') {
    lines.push(
      '- Convex setup (convex dev, convex auth) will be run AUTOMATICALLY after you finish, so do not run it yourself.',
    );
  }
  if (ctx.backend) {
    lines.push(
      "- Environment variables should be queued via `addEnvironmentVariables` — they'll be applied during the final setup phase.",
    );
  }
  return lines.join('\n');
}

export function cliSystemPrompt(ctx: CliContext): string {
  const skillsCatalog = generateSkillsSummary(ctx.stack);

  return `## CLI Agent Mode — Parallel Execution

You run on the user's local machine, IN PARALLEL with \`npm install\`.
The project template has been copied. \`npm install\` is running in the BACKGROUND
while you generate code.${ctx.backend === 'convex' ? ' Convex setup runs AUTOMATICALLY after you finish.' : ''}

### What runs in parallel with you
- Base \`npm install\` — started before you; will finish during or shortly after your work

### What runs AFTER you finish (do NOT do these yourself)
${afterYouFinishSection(ctx)}

### What you should NOT do
${doNotDoSection(ctx)}

### What you SHOULD do
- Use \`viewFile\` or \`readMultipleFiles\` to inspect template files before modifying
- Use \`createFile\` to write new files or overwrite existing ones with full content
- Use \`editFile\` for small targeted changes (always \`viewFile\` first)
${packageInstallHint(ctx)}
- Use \`listDirectory\` to understand structure
- Use \`searchFiles\` to find patterns
- Use \`deleteFile\` / \`renameFile\` as needed
- Use \`lookupDocs\` BEFORE implementing advanced features
${envVarHint(ctx)}

## Documentation Lookup — lookupDocs

Call \`lookupDocs({ skills: ["skill-name"] })\` before writing code for an advanced feature.
Multiple at once: \`lookupDocs({ skills: ["convex-file-storage", "expo-image-media"] })\`

### Available Skills

${skillsCatalog}

### When to use lookupDocs

- ALWAYS call lookupDocs before implementing a feature covered by a skill
- Load ONLY the specific skills you need
- You do NOT need lookupDocs for basic CRUD, simple queries, or standard RN components

## Available Tools

### createFile
Write a complete file. Works immediately — does not need dependencies.

### editFile
Replace a unique string in a file. \`viewFile\` first.

### runCommand
Shell commands. npm/npx/yarn/pnpm calls auto-wait for background install.${ctx.frontend === 'expo' ? ' Use ONLY for `npx expo install <pkg>`.' : ''}

### viewFile / readMultipleFiles / listDirectory / searchFiles
Read-only filesystem inspection. Always safe.

### deleteFile / renameFile
Filesystem modifications. Always safe.

### lookupDocs
Load skill documentation. Pass array of skill names.

${ctx.backend ? '### addEnvironmentVariables\nQueue env vars for the final backend setup phase.\n\n' : ''}### checkDependencies
Check background \`npm install\` state. Rarely needed — file ops don't depend on it.

## Workflow

${workflowSteps(ctx)}

### Parallel Execution Notice
${parallelNotice(ctx)}
`;
}
