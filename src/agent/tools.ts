// src/agent/tools.ts
//
// Tool definitions and executors for the CLI agent.
//
// Streaming model:
//   - Every action shows a LIVE spinner that ticks continuously while the
//     underlying work runs — no more busy-waits, no more silent periods.
//   - Long-running commands (npm install, npx expo install) stream their
//     stdout/stderr to the terminal in real time as dim lines, so the user
//     sees exactly what's happening.
//   - File contents are NEVER dumped to the terminal. Only filenames,
//     line counts, and status labels are shown.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import chalk, { type ChalkInstance } from 'chalk';
import { z } from 'zod';
import {
  readSkill,
  readSkills,
  getSkillNames,
  getSkillNamesForStack,
  type StackId,
} from './skills.js';
import type { InstallManager } from '../utils/installManager.js';
import { startSpinner, type LiveSpinner } from '../utils/liveSpinner.js';
import { Session } from '../session/session.js';

// ─── Execution context ───────────────────────────────────────────────────────

export interface ToolContext {
  projectRoot: string;
  installManager: InstallManager;
  /** Optional — present when running inside a conversational session.
   *  When present, mutating tools record to the journal for /undo. */
  session?: Session;
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

function buildLookupDocsSchema(skillNames: string[]) {
  return z.object({
    skills: z
      .array(z.string())
      .min(1)
      .max(4)
      .describe(
        `One or more skill names to load. Available: ${skillNames.join(', ')}. ` +
          `Load only what you need — each skill consumes context tokens.`,
      ),
  });
}

// Fallback schema covering every known skill — used for type inference and
// when no stack is available. Tool definitions passed to the model are always
// built via `buildToolDefinitions(stack)` so the agent sees only stack-relevant
// skills.
export const LookupDocsSchema = buildLookupDocsSchema(getSkillNames());

export const AddEnvironmentVariablesSchema = z.object({
  envVarNames: z.array(z.string()),
});

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

/**
 * Build the tool definitions sent to the model.
 *
 * When `stack` is provided, the `lookupDocs` tool is scoped to only the
 * skills that belong to that stack's tech buckets — the agent never sees
 * or calls into skills irrelevant to the chosen frontend/backend.
 */
export const buildToolDefinitions = (stack?: StackId) => {
  const availableSkills = stack
    ? getSkillNamesForStack(stack)
    : getSkillNames();
  const lookupDocsSchema = buildLookupDocsSchema(availableSkills);

  return [
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
    toolDef(
      'deleteFile',
      'Delete a file or empty directory.',
      DeleteFileSchema,
    ),
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
        availableSkills.join(', '),
      lookupDocsSchema,
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
};

/**
 * Default tool definitions — covers every skill. Kept for backwards
 * compatibility with call sites that don't have a stack available.
 * Prefer `buildToolDefinitions(stack)` in new code.
 */
export const toolDefinitions = buildToolDefinitions();

// ─── Queued environment variables ───────────────────────────────────────────

const pendingEnvVars = new Set<string>();

export function getPendingEnvVars(): string[] {
  return Array.from(pendingEnvVars).sort();
}

export function clearPendingEnvVars(): void {
  pendingEnvVars.clear();
}

// ─── Action label helpers ───────────────────────────────────────────────────

type ActionKind =
  | 'create'
  | 'update'
  | 'delete'
  | 'rename'
  | 'run'
  | 'docs'
  | 'env'
  | 'queue'
  | 'read'
  | 'search'
  | 'list';

const ACTION_STYLE: Record<ActionKind, { verb: string; color: ChalkInstance }> =
  {
    create: { verb: 'Creating', color: chalk.green },
    update: { verb: 'Updating', color: chalk.yellow },
    delete: { verb: 'Removing', color: chalk.red },
    rename: { verb: 'Moving', color: chalk.blue },
    run: { verb: 'Running', color: chalk.magenta },
    docs: { verb: 'Loading skill', color: chalk.cyan },
    env: { verb: 'Queued env var', color: chalk.hex('#f59e0b') },
    queue: { verb: 'Queued (deps)', color: chalk.dim },
    read: { verb: 'Reading', color: chalk.blue },
    search: { verb: 'Searching', color: chalk.blue },
    list: { verb: 'Listing', color: chalk.blue },
  };

function actionLabel(kind: ActionKind, target: string, extra?: string): string {
  const { verb, color } = ACTION_STYLE[kind];
  const tail = extra ? chalk.dim(` ${extra}`) : '';
  return `${color(verb)} ${chalk.cyan(target)}${tail}`;
}

/** Print a clean completion line for fast synchronous work. */
function quickAction(kind: ActionKind, target: string, extra?: string): void {
  const { verb, color } = ACTION_STYLE[kind];
  const tail = extra ? chalk.dim(` ${extra}`) : '';
  process.stdout.write(
    `  ${color('✓')} ${color(verb)} ${chalk.cyan(target)}${tail}\n`,
  );
}

// ─── Filesystem Tool Executors ───────────────────────────────────────────────

export function executeCreateFile(
  projectRoot: string,
  args: z.infer<typeof CreateFileSchema>,
  session?: Session, // NEW parameter
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  const lines = args.content.split('\n').length;

  // NEW: record BEFORE we overwrite
  if (session) {
    session.recordOperation(existed ? 'update' : 'create', args.filePath);
  }

  const spinner = startSpinner(
    actionLabel(
      existed ? 'update' : 'create',
      args.filePath,
      `(${lines} lines)`,
    ),
  );
  try {
    fs.writeFileSync(fullPath, args.content, 'utf-8');
    spinner.succeed(
      actionLabel(
        existed ? 'update' : 'create',
        args.filePath,
        `(${lines} lines)`,
      ),
    );
  } catch (err) {
    spinner.fail(`Failed to write ${args.filePath}`);
    throw err;
  }

  return `Successfully ${existed ? 'updated' : 'created'} ${args.filePath} (${lines} lines)`;
}

export function executeEditFile(
  projectRoot: string,
  args: z.infer<typeof EditFileSchema>,
  session?: Session,
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

  if (session) {
    session.recordOperation('update', args.filePath);
  }

  const oldLines = args.oldText.split('\n').length;
  const newLines = args.newText.split('\n').length;
  const extra =
    oldLines !== newLines ? `(${oldLines}→${newLines} lines)` : undefined;

  const spinner = startSpinner(actionLabel('update', args.filePath, extra));
  try {
    const newContent = content.replace(args.oldText, args.newText);
    fs.writeFileSync(fullPath, newContent, 'utf-8');
    spinner.succeed(actionLabel('update', args.filePath, extra));
  } catch (err) {
    spinner.fail(`Failed to edit ${args.filePath}`);
    throw err;
  }

  return `Successfully edited ${args.filePath}`;
}

// ─── runCommand — streams output live, no buffering ─────────────────────────

function isNpmFamily(cmd: string): boolean {
  const trimmed = cmd.trim();
  return /^(npm|npx|yarn|pnpm|bun(?:x)?)\b/.test(trimmed);
}

/**
 * Spawn a command and stream its stdout/stderr live to the terminal as
 * dim indented lines. Also captures the full output for the tool-result
 * return value. The user sees progress continuously — no silent periods.
 */
async function spawnWithLiveOutput(
  command: string,
  cwd: string,
  timeoutMs: number,
  spinner: LiveSpinner,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });

    let captured = '';
    let lineBuf = '';

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      captured += text;
      // Cap captured output so tool-result stays reasonable
      if (captured.length > 32_000) captured = captured.slice(-16_000);

      lineBuf += text;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';

      for (const rawLine of parts) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        // Route live progress through the spinner so it renders cleanly
        // above the animated spinner line.
        spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(line));
      }
    };

    proc.stdout?.on('data', handleChunk);
    proc.stderr?.on('data', handleChunk);

    const timer = setTimeout(() => {
      spinner.writeAbove(chalk.red('    │ (timeout — killing process)'));
      try {
        proc.kill('SIGTERM');
      } catch {
        /* noop */
      }
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `spawn error: ${err.message}` });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      // Flush any trailing partial line
      if (lineBuf.trim()) {
        spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(lineBuf.trim()));
      }
      resolve({
        ok: code === 0,
        output:
          captured.trim() ||
          (code === 0 ? '(command completed)' : `command exited with ${code}`),
      });
    });
  });
}

export async function executeRunCommand(
  ctx: ToolContext,
  args: z.infer<typeof RunCommandSchema>,
): Promise<string> {
  const timeoutMs = args.timeout ?? 180_000;

  // npm-family → route through InstallManager (waits for base install,
  // then streams output live).
  if (isNpmFamily(args.command)) {
    const status = ctx.installManager.getStatus();
    const isWaiting = status === 'installing' || status === 'pending';

    const spinnerLabel = isWaiting
      ? actionLabel('queue', args.command, '(waiting for base install)')
      : actionLabel('run', args.command);

    const spinner = startSpinner(spinnerLabel);

    try {
      const result = await ctx.installManager.runDependentCommand(
        args.command,
        timeoutMs,
        // Live streaming callback — every line from the child process
        // gets written above the spinner in real time.
        (line) => spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(line)),
        // Status change callback — when the base install finishes and
        // our queued command actually starts, update the spinner text.
        () => spinner.update(actionLabel('run', args.command)),
      );

      if (result.ok) {
        spinner.succeed(actionLabel('run', args.command, '✓'));
      } else {
        spinner.fail(actionLabel('run', args.command, 'failed'));
      }

      const out = result.output;
      const truncated =
        out.length > 4000
          ? out.slice(0, 2000) + '\n...(truncated)...\n' + out.slice(-2000)
          : out;
      return result.ok ? truncated : `Error: ${truncated}`;
    } catch (err: any) {
      spinner.fail(actionLabel('run', args.command, 'failed'));
      return `Error: ${err.message ?? 'unknown error'}`;
    }
  }

  // Non-npm commands — stream live via spawn.
  const spinner = startSpinner(actionLabel('run', args.command));
  try {
    const result = await spawnWithLiveOutput(
      args.command,
      ctx.projectRoot,
      timeoutMs,
      spinner,
    );
    if (result.ok) {
      spinner.succeed(actionLabel('run', args.command, '✓'));
    } else {
      spinner.fail(actionLabel('run', args.command, 'failed'));
    }
    const out = result.output;
    const truncated =
      out.length > 4000
        ? out.slice(0, 2000) + '\n...(truncated)...\n' + out.slice(-2000)
        : out;
    return result.ok ? truncated : `Error: ${truncated}`;
  } catch (err: any) {
    spinner.fail(actionLabel('run', args.command, 'failed'));
    return `Error: ${err.message ?? 'unknown error'}`;
  }
}

// ─── Read-only tools ────────────────────────────────────────────────────────

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

  const spinner = startSpinner(actionLabel('read', args.filePath));
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const start = (args.startLine ?? 1) - 1;
  const end =
    args.endLine === -1 ? lines.length : (args.endLine ?? lines.length);
  const slice = lines.slice(Math.max(0, start), end);
  spinner.succeed(
    actionLabel('read', args.filePath, `(${slice.length} lines)`),
  );
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
  const dirPath = args.dirPath ?? '.';
  const fullPath = path.resolve(projectRoot, dirPath);
  if (!fs.existsSync(fullPath)) {
    return `Error: Directory not found: ${dirPath}`;
  }

  const spinner = startSpinner(actionLabel('list', dirPath));

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
  spinner.succeed(actionLabel('list', dirPath, `(${result.length} entries)`));
  return 'Directory:\n' + result.join('\n');
}

export function executeDeleteFile(
  projectRoot: string,
  args: z.infer<typeof DeleteFileSchema>,
  session?: Session,
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  if (!fs.existsSync(fullPath))
    return `Error: File not found: ${args.filePath}`;

  if (session) session.recordOperation('delete', args.filePath);

  const spinner = startSpinner(actionLabel('delete', args.filePath));
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) fs.rmdirSync(fullPath);
  else fs.unlinkSync(fullPath);
  spinner.succeed(actionLabel('delete', args.filePath));
  return `Successfully deleted ${args.filePath}`;
}

export function executeRenameFile(
  projectRoot: string,
  args: z.infer<typeof RenameFileSchema>,
  session?: Session,
): string {
  const srcFull = path.resolve(projectRoot, args.oldPath);
  const destFull = path.resolve(projectRoot, args.newPath);
  if (!fs.existsSync(srcFull)) {
    return `Error: Source file not found: ${args.oldPath}`;
  }
  if (session) session.recordRename(args.oldPath, args.newPath);

  const label = `${args.oldPath} → ${args.newPath}`;
  const spinner = startSpinner(actionLabel('rename', label));
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(srcFull, destFull);
  spinner.succeed(actionLabel('rename', label));
  return `Successfully renamed ${args.oldPath} → ${args.newPath}`;
}

export async function executeSearchFiles(
  projectRoot: string,
  args: z.infer<typeof SearchFilesSchema>,
): Promise<string> {
  const maxResults = args.maxResults ?? 20;
  const spinner = startSpinner(actionLabel('search', args.pattern));

  return new Promise<string>((resolve) => {
    const globFlag = args.fileGlob ? `--include="${args.fileGlob}"` : '';
    const cmd = `grep -rn ${globFlag} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.expo --exclude-dir=_generated --exclude-dir=ios --exclude-dir=android -m ${maxResults} "${args.pattern.replace(/"/g, '\\"')}" . 2>/dev/null || true`;
    const proc = spawn(cmd, {
      cwd: projectRoot,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout?.on('data', (c) => {
      out += c.toString();
      if (out.length > 32_000) out = out.slice(-16_000);
    });
    proc.on('close', () => {
      const trimmed = out.trim();
      if (!trimmed) {
        spinner.succeed(actionLabel('search', args.pattern, '(no matches)'));
        resolve(`No matches found for "${args.pattern}"`);
        return;
      }
      const lines = trimmed.split('\n').slice(0, maxResults);
      spinner.succeed(
        actionLabel('search', args.pattern, `(${lines.length} matches)`),
      );
      resolve(`Found ${lines.length} match(es):\n` + lines.join('\n'));
    });
    proc.on('error', () => {
      spinner.fail(actionLabel('search', args.pattern, 'failed'));
      resolve(`Search failed for pattern "${args.pattern}".`);
    });
  });
}

export function executeReadMultipleFiles(
  projectRoot: string,
  args: z.infer<typeof ReadMultipleFilesSchema>,
): string {
  const spinner = startSpinner(
    actionLabel('read', `${args.filePaths.length} files`),
  );
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
  spinner.succeed(actionLabel('read', `${args.filePaths.length} files`, '✓'));
  return results.join('\n\n');
}

export function executeAddEnvironmentVariables(
  args: z.infer<typeof AddEnvironmentVariablesSchema>,
): string {
  for (const name of args.envVarNames) {
    pendingEnvVars.add(name);
  }
  quickAction('env', args.envVarNames.join(', '));
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
      return executeCreateFile(ctx.projectRoot, toolInput as any, ctx.session);
    case 'editFile':
      return executeEditFile(ctx.projectRoot, toolInput as any, ctx.session);
    case 'deleteFile':
      return executeDeleteFile(ctx.projectRoot, toolInput as any, ctx.session);
    case 'renameFile':
      return executeRenameFile(ctx.projectRoot, toolInput as any, ctx.session);
    case 'runCommand':
      return executeRunCommand(ctx, toolInput as any);
    case 'viewFile':
      return executeViewFile(ctx.projectRoot, toolInput as any);
    case 'listDirectory':
      return executeListDirectory(ctx.projectRoot, toolInput as any);
    case 'searchFiles':
      return executeSearchFiles(ctx.projectRoot, toolInput as any);
    case 'readMultipleFiles':
      return executeReadMultipleFiles(ctx.projectRoot, toolInput as any);
    case 'lookupDocs': {
      const args = toolInput as z.infer<typeof LookupDocsSchema>;
      for (const skill of args.skills) {
        quickAction('docs', skill);
      }
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
