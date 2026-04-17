// src/agent/tools.ts
//
// Tool definitions and executors for the CLI agent.
//
// Parallelism change:
//   - `runCommand` now routes npm/npx/yarn/pnpm commands through the
//     InstallManager so they're serialized behind the base `npm install`
//     and behind each other. This lets the agent run in parallel with
//     dependency installation without creating lockfile conflicts.
//   - All other tools (filesystem, docs) remain synchronous.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk, { type ChalkInstance } from 'chalk';
import { z } from 'zod';
import { readSkill, readSkills, getSkillNames } from './skills.js';
import type { InstallManager } from '../utils/installManager.js';

// ─── Execution context ───────────────────────────────────────────────────────
// Passed into executeTool so tools can access shared runtime state.

export interface ToolContext {
  projectRoot: string;
  installManager: InstallManager;
}

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

export const CreateFileSchema = z.object({
  filePath: z
    .string()
    .describe(
      'Relative path to the file (e.g. "app/(home)/index.tsx", "convex/schema.ts")',
    ),
  content: z
    .string()
    .describe('Full file content to write. Must be the complete file.'),
});

export const EditFileSchema = z.object({
  filePath: z.string().describe('Relative path to the file to edit'),
  oldText: z
    .string()
    .describe(
      'The exact text to find and replace. Must be unique in the file and under 1024 chars.',
    ),
  newText: z.string().describe('The replacement text. Under 1024 chars.'),
});

export const RunCommandSchema = z.object({
  command: z
    .string()
    .describe('Shell command to execute (e.g. "npx expo install expo-camera")'),
  timeout: z
    .number()
    .optional()
    .describe('Timeout in milliseconds (default 180000)'),
});

export const ViewFileSchema = z.object({
  filePath: z.string().describe('Relative path to the file to read'),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
});

export const ListDirectorySchema = z.object({
  dirPath: z.string().optional(),
  recursive: z.boolean().optional(),
});

export const DeleteFileSchema = z.object({
  filePath: z.string(),
});

export const RenameFileSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
});

export const SearchFilesSchema = z.object({
  pattern: z.string(),
  fileGlob: z.string().optional(),
  maxResults: z.number().optional(),
});

export const ReadMultipleFilesSchema = z.object({
  filePaths: z.array(z.string()),
});

const skillNames = getSkillNames();

export const LookupDocsSchema = z.object({
  skills: z
    .array(z.string())
    .min(1)
    .max(4)
    .describe(
      `One or more skill names to load. Available: ${skillNames.join(', ')}. ` +
        `Load only what you need — each skill consumes context tokens.`,
    ),
});

export const AddEnvironmentVariablesSchema = z.object({
  envVarNames: z.array(z.string()),
});

// New tool — lets the agent explicitly check install state when it matters.
export const CheckDependenciesSchema = z.object({});

// ─── Tool name type ──────────────────────────────────────────────────────────

export type ToolName =
  | 'createFile'
  | 'editFile'
  | 'runCommand'
  | 'viewFile'
  | 'listDirectory'
  | 'deleteFile'
  | 'renameFile'
  | 'searchFiles'
  | 'readMultipleFiles'
  | 'lookupDocs'
  | 'addEnvironmentVariables'
  | 'checkDependencies';

// ─── Tool Definitions (sent to Anthropic API) ────────────────────────────────

function toolDef(name: string, description: string, schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema);
  const { $schema, ...rest } = jsonSchema as any;
  return { name, description, input_schema: rest };
}

export const toolDefinitions = [
  toolDef(
    'createFile',
    'Create or overwrite a file on the local file system. This tool works IMMEDIATELY — it does not depend on npm packages being installed. Always write the complete file content.',
    CreateFileSchema,
  ),
  toolDef(
    'editFile',
    'Replace a unique string in a file with new content. Works immediately — does not depend on npm packages.',
    EditFileSchema,
  ),
  toolDef(
    'runCommand',
    'Execute a shell command. Dependency installs (npm/npx/yarn/pnpm) are automatically serialized behind the base `npm install` running in the background, so it is safe to call these at any time — they will just wait if needed. Use ONLY for `npx expo install <pkg>` when adding packages not in the template. Returns stdout + stderr.',
    RunCommandSchema,
  ),
  toolDef(
    'viewFile',
    'Read the contents of a file. Returns numbered lines. Works immediately.',
    ViewFileSchema,
  ),
  toolDef(
    'listDirectory',
    'List files and directories. Filters node_modules, .git, .expo, _generated.',
    ListDirectorySchema,
  ),
  toolDef('deleteFile', 'Delete a file or empty directory.', DeleteFileSchema),
  toolDef('renameFile', 'Rename or move a file.', RenameFileSchema),
  toolDef(
    'searchFiles',
    'Search for a text pattern across project files. Returns matching paths and line numbers.',
    SearchFilesSchema,
  ),
  toolDef(
    'readMultipleFiles',
    'Read multiple files at once. More efficient than multiple viewFile calls.',
    ReadMultipleFilesSchema,
  ),
  toolDef(
    'lookupDocs',
    'Load reference documentation for specific features. Available skills: ' +
      skillNames.join(', '),
    LookupDocsSchema,
  ),
  toolDef(
    'addEnvironmentVariables',
    'Queue environment variables to be set on the Convex deployment. These will be applied at the end of the run during the Convex setup phase. Use this for API keys and secrets like OPENAI_API_KEY or STRIPE_SECRET_KEY.',
    AddEnvironmentVariablesSchema,
  ),
  toolDef(
    'checkDependencies',
    'Check whether the background `npm install` has completed. Returns the current status. You rarely need this — just call runCommand when you need to install a new package, and it will wait automatically.',
    CheckDependenciesSchema,
  ),
];

// ─── Queued environment variables (processed post-agent) ─────────────────────
// The agent accumulates env var requests here; the command layer reads them
// after the agent finishes to display instructions during Convex setup.

const pendingEnvVars = new Set<string>();

export function getPendingEnvVars(): string[] {
  return Array.from(pendingEnvVars).sort();
}

export function clearPendingEnvVars(): void {
  pendingEnvVars.clear();
}

// ─── Shimmer animation ───────────────────────────────────────────────────────

const SHIMMER_FRAMES = ['░', '▒', '▓', '█', '▓', '▒'];

function shimmerText(text: string, color: ChalkInstance): void {
  const frames = SHIMMER_FRAMES;
  const totalFrames = frames.length * 2;
  let frame = 0;

  const interval = setInterval(() => {
    const shimmer = frames[frame % frames.length];
    process.stdout.write(
      `\r  ${color(shimmer)} ${color(text)} ${color(shimmer)}`,
    );
    frame++;
    if (frame >= totalFrames) {
      clearInterval(interval);
      process.stdout.write(`\r  ${color('✓')} ${color(text)}   \n`);
    }
  }, 60);

  const waitMs = totalFrames * 60 + 20;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    /* busy-wait to keep the animation visible */
  }
}

function showActionLabel(
  action:
    | 'create'
    | 'update'
    | 'delete'
    | 'rename'
    | 'run'
    | 'docs'
    | 'env'
    | 'queue',
  filePath: string,
  lines?: number,
): void {
  const labels: Record<string, { verb: string; color: ChalkInstance }> = {
    create: { verb: 'Creating', color: chalk.green },
    update: { verb: 'Updating', color: chalk.yellow },
    delete: { verb: 'Removing', color: chalk.red },
    rename: { verb: 'Moving', color: chalk.blue },
    run: { verb: 'Running', color: chalk.magenta },
    docs: { verb: 'Loading skill', color: chalk.cyan },
    env: { verb: 'Queued env var', color: chalk.hex('#f59e0b') },
    queue: { verb: 'Queued (deps)', color: chalk.dim },
  };

  const { verb, color } = labels[action];
  const lineInfo = lines ? chalk.dim(` (${lines} lines)`) : '';
  const label = `${verb} ${chalk.cyan(filePath)}${lineInfo}`;

  shimmerText(label, color);
}

// ─── Filesystem Tool Executors ───────────────────────────────────────────────

export function executeCreateFile(
  projectRoot: string,
  args: z.infer<typeof CreateFileSchema>,
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  fs.writeFileSync(fullPath, args.content, 'utf-8');

  const lines = args.content.split('\n').length;
  showActionLabel(existed ? 'update' : 'create', args.filePath, lines);

  return `Successfully ${existed ? 'updated' : 'created'} ${args.filePath} (${lines} lines)`;
}

export function executeEditFile(
  projectRoot: string,
  args: z.infer<typeof EditFileSchema>,
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  if (!fs.existsSync(fullPath)) {
    return `Error: File not found: ${args.filePath}`;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const occurrences = content.split(args.oldText).length - 1;

  if (occurrences === 0) {
    return `Error: The specified text was not found in ${args.filePath}. Use viewFile to check current contents.`;
  }
  if (occurrences > 1) {
    return `Error: The specified text appears ${occurrences} times in ${args.filePath}. It must be unique.`;
  }

  const newContent = content.replace(args.oldText, args.newText);
  fs.writeFileSync(fullPath, newContent, 'utf-8');

  const oldLines = args.oldText.split('\n').length;
  const newLines = args.newText.split('\n').length;
  showActionLabel('update', args.filePath);
  if (oldLines !== newLines) {
    console.log(chalk.dim(`    ${oldLines} lines → ${newLines} lines`));
  }
  return `Successfully edited ${args.filePath}`;
}

// ─── runCommand — routed through InstallManager for npm-family commands ─────

function isNpmFamily(cmd: string): boolean {
  const trimmed = cmd.trim();
  return /^(npm|npx|yarn|pnpm|bun(?:x)?)\b/.test(trimmed);
}

export async function executeRunCommand(
  ctx: ToolContext,
  args: z.infer<typeof RunCommandSchema>,
): Promise<string> {
  const timeoutMs = args.timeout ?? 180_000;

  // Route npm-family commands through the install manager.
  // This gives us:
  //   1. Automatic wait behind the background `npm install`
  //   2. Serialization so we don't mutate node_modules concurrently
  if (isNpmFamily(args.command)) {
    const status = ctx.installManager.getStatus();

    if (status === 'installing' || status === 'pending') {
      showActionLabel('queue', args.command);
      console.log(
        chalk.dim('    Waiting for base dependencies to finish installing...'),
      );
    } else {
      showActionLabel('run', args.command);
    }

    const result = await ctx.installManager.runDependentCommand(
      args.command,
      timeoutMs,
    );

    // Surface a truncated view in the terminal
    if (result.output) {
      const lines = result.output.split('\n');
      if (lines.length > 10) {
        for (const line of lines.slice(0, 3)) {
          console.log(chalk.dim('    ') + chalk.dim(line));
        }
        console.log(chalk.dim(`    ... ${lines.length - 5} more lines ...`));
        for (const line of lines.slice(-2)) {
          console.log(chalk.dim('    ') + chalk.dim(line));
        }
      } else {
        for (const line of lines) {
          console.log(chalk.dim('    ') + chalk.dim(line));
        }
      }
    }

    const truncated =
      result.output.length > 4000
        ? result.output.slice(0, 2000) +
          '\n...(truncated)...\n' +
          result.output.slice(-2000)
        : result.output;

    return result.ok
      ? truncated || '(command completed)'
      : `Error: ${truncated}`;
  }

  // Non-npm commands — run synchronously via execSync (original behaviour).
  showActionLabel('run', args.command);
  try {
    const output = execSync(args.command, {
      cwd: ctx.projectRoot,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const trimmed = output.trim();
    if (trimmed) {
      const lines = trimmed.split('\n');
      if (lines.length > 10) {
        for (const line of lines.slice(0, 3)) {
          console.log(chalk.dim('    ') + chalk.dim(line));
        }
        console.log(chalk.dim(`    ... ${lines.length - 5} more lines ...`));
        for (const line of lines.slice(-2)) {
          console.log(chalk.dim('    ') + chalk.dim(line));
        }
      } else {
        for (const line of lines) {
          console.log(chalk.dim('    ') + chalk.dim(line));
        }
      }
    }
    return trimmed.length > 4000
      ? trimmed.slice(0, 2000) + '\n...(truncated)...\n' + trimmed.slice(-2000)
      : trimmed || '(command completed with no output)';
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    const stdout = err.stdout?.toString() ?? '';
    const combined = (stdout + '\n' + stderr).trim();
    if (combined) {
      const lines = combined.split('\n').slice(-5);
      for (const line of lines) {
        console.log(chalk.red('    ') + line);
      }
    }
    return `Error (exit ${err.status ?? '?'}): ${combined.slice(0, 4000)}`;
  }
}

export function executeViewFile(
  projectRoot: string,
  args: z.infer<typeof ViewFileSchema>,
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  if (!fs.existsSync(fullPath))
    return `Error: File not found: ${args.filePath}`;
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return `Error: ${args.filePath} is a directory, use listDirectory instead`;
  }
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const start = (args.startLine ?? 1) - 1;
  const end =
    args.endLine === -1 ? lines.length : (args.endLine ?? lines.length);
  const slice = lines.slice(Math.max(0, start), end);
  return slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
}

export function executeListDirectory(
  projectRoot: string,
  args: z.infer<typeof ListDirectorySchema>,
): string {
  const SKIP = new Set([
    'node_modules',
    '.git',
    '.expo',
    '_generated',
    'ios',
    'android',
    '.DS_Store',
  ]);
  const fullPath = path.resolve(projectRoot, args.dirPath ?? '.');
  if (!fs.existsSync(fullPath)) {
    return `Error: Directory not found: ${args.dirPath ?? '.'}`;
  }

  function listDir(dir: string, depth: number, maxDepth: number): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const filtered = entries.filter((e) => !SKIP.has(e.name));
    const lines: string[] = [];
    const indent = '  '.repeat(depth);
    for (const e of filtered) {
      const marker = e.isDirectory() ? '(dir)' : '(file)';
      lines.push(`${indent}- ${e.name} ${marker}`);
      if (e.isDirectory() && depth < maxDepth) {
        lines.push(...listDir(path.join(dir, e.name), depth + 1, maxDepth));
      }
    }
    return lines;
  }

  const maxDepth = args.recursive ? 2 : 0;
  const result = listDir(fullPath, 0, maxDepth);
  return 'Directory:\n' + result.join('\n');
}

export function executeDeleteFile(
  projectRoot: string,
  args: z.infer<typeof DeleteFileSchema>,
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  if (!fs.existsSync(fullPath))
    return `Error: File not found: ${args.filePath}`;
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) fs.rmdirSync(fullPath);
  else fs.unlinkSync(fullPath);
  showActionLabel('delete', args.filePath);
  return `Successfully deleted ${args.filePath}`;
}

export function executeRenameFile(
  projectRoot: string,
  args: z.infer<typeof RenameFileSchema>,
): string {
  const srcFull = path.resolve(projectRoot, args.oldPath);
  const destFull = path.resolve(projectRoot, args.newPath);
  if (!fs.existsSync(srcFull)) {
    return `Error: Source file not found: ${args.oldPath}`;
  }
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(srcFull, destFull);
  showActionLabel('rename', `${args.oldPath} → ${args.newPath}`);
  return `Successfully renamed ${args.oldPath} → ${args.newPath}`;
}

export function executeSearchFiles(
  projectRoot: string,
  args: z.infer<typeof SearchFilesSchema>,
): string {
  const maxResults = args.maxResults ?? 20;
  try {
    const globFlag = args.fileGlob ? `--include="${args.fileGlob}"` : '';
    const cmd = `grep -rn ${globFlag} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.expo --exclude-dir=_generated --exclude-dir=ios --exclude-dir=android -m ${maxResults} "${args.pattern.replace(/"/g, '\\"')}" . 2>/dev/null || true`;
    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 15_000,
    }).trim();
    if (!output) return `No matches found for "${args.pattern}"`;
    const lines = output.split('\n').slice(0, maxResults);
    return `Found ${lines.length} match(es):\n` + lines.join('\n');
  } catch {
    return `Search failed for pattern "${args.pattern}".`;
  }
}

export function executeReadMultipleFiles(
  projectRoot: string,
  args: z.infer<typeof ReadMultipleFilesSchema>,
): string {
  const results: string[] = [];
  for (const filePath of args.filePaths) {
    const fullPath = path.resolve(projectRoot, filePath);
    if (!fs.existsSync(fullPath)) {
      results.push(`--- ${filePath} ---\nError: File not found`);
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(`--- ${filePath} ---\nError: Is a directory`);
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    results.push(`--- ${filePath} (${lines.length} lines) ---\n${numbered}`);
  }
  return results.join('\n\n');
}

export function executeAddEnvironmentVariables(
  args: z.infer<typeof AddEnvironmentVariablesSchema>,
): string {
  for (const name of args.envVarNames) {
    pendingEnvVars.add(name);
  }
  showActionLabel('env', args.envVarNames.join(', '));

  return (
    `Queued ${args.envVarNames.length} environment variable(s): ${args.envVarNames.join(', ')}.\n\n` +
    `These will be set on the Convex deployment AFTER you finish generating code, during the final setup phase. ` +
    `Continue writing the app as if these will be available via process.env.<NAME>.`
  );
}

export function executeCheckDependencies(ctx: ToolContext): string {
  return ctx.installManager.getStatusSummary();
}

// ─── Tool Router ─────────────────────────────────────────────────────────────

export async function executeTool(
  ctx: ToolContext,
  toolName: ToolName,
  toolInput: Record<string, any>,
): Promise<string> {
  switch (toolName) {
    case 'createFile':
      return executeCreateFile(ctx.projectRoot, toolInput as any);
    case 'editFile':
      return executeEditFile(ctx.projectRoot, toolInput as any);
    case 'runCommand':
      return executeRunCommand(ctx, toolInput as any);
    case 'viewFile':
      return executeViewFile(ctx.projectRoot, toolInput as any);
    case 'listDirectory':
      return executeListDirectory(ctx.projectRoot, toolInput as any);
    case 'deleteFile':
      return executeDeleteFile(ctx.projectRoot, toolInput as any);
    case 'renameFile':
      return executeRenameFile(ctx.projectRoot, toolInput as any);
    case 'searchFiles':
      return executeSearchFiles(ctx.projectRoot, toolInput as any);
    case 'readMultipleFiles':
      return executeReadMultipleFiles(ctx.projectRoot, toolInput as any);
    case 'lookupDocs': {
      const args = toolInput as z.infer<typeof LookupDocsSchema>;
      for (const skill of args.skills) showActionLabel('docs', skill);
      if (args.skills.length === 1) return readSkill(args.skills[0]);
      return readSkills(args.skills);
    }
    case 'addEnvironmentVariables':
      return executeAddEnvironmentVariables(toolInput as any);
    case 'checkDependencies':
      return executeCheckDependencies(ctx);
    default:
      return `Error: Unknown tool ${toolName}`;
  }
}
