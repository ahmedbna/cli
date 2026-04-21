// src/agent/tools.ts
//
// Tool definitions and executors for the CLI agent.
//
// UI integration:
//   - Every tool executor opens a ToolUi channel (src/ui/toolAdapter.ts),
//     which transparently dispatches to either:
//       * the Ink event bus (when UI is active) → compact inline tool lines
//       * the legacy liveSpinner              (otherwise) → old animated UI
//   - No executor writes to stdout directly anymore. They all go through
//     ui.progress / ui.succeed / ui.fail.
//
// Tool contract is unchanged — same names, schemas, return values.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { z } from 'zod';
import {
  readSkill,
  readSkills,
  getSkillNames,
  getSkillNamesForStack,
  type StackId,
} from './skills.js';
import type { InstallManager } from '../utils/installManager.js';
import { Session } from '../session/session.js';
import { createToolUi, quickToolAction } from '../ui/toolAdapter.js';

// ─── Execution context ───────────────────────────────────────────────────────

export interface ToolContext {
  projectRoot: string;
  installManager: InstallManager;
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

// ─── Tool Definitions (unchanged) ────────────────────────────────────────────

function toolDef(name: string, description: string, schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema);
  const { $schema, ...rest } = jsonSchema as any;
  return { name, description, input_schema: rest };
}

export const buildToolDefinitions = (stack?: StackId) => {
  const availableSkills = stack
    ? getSkillNamesForStack(stack)
    : getSkillNames();
  const lookupDocsSchema = buildLookupDocsSchema(availableSkills);

  return [
    toolDef(
      'createFile',
      'Create or overwrite a file on the local file system. This tool works IMMEDIATELY — it does not depend on npm packages being installed. Always write the complete file content. createFile auto-creates parent directories. Use this only when you need an empty directory up front.',
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

export const toolDefinitions = buildToolDefinitions();

// ─── Queued environment variables ───────────────────────────────────────────

const pendingEnvVars = new Set<string>();

export function getPendingEnvVars(): string[] {
  return Array.from(pendingEnvVars).sort();
}

export function clearPendingEnvVars(): void {
  pendingEnvVars.clear();
}

// ─── Filesystem Tool Executors ───────────────────────────────────────────────

export function executeCreateFile(
  projectRoot: string,
  args: z.infer<typeof CreateFileSchema>,
  session?: Session,
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  const lines = args.content.split('\n').length;

  if (session) {
    session.recordOperation(existed ? 'update' : 'create', args.filePath);
  }

  // A file create/edit is very fast — we open the ToolUi channel, do the
  // synchronous write, and immediately terminate. The user sees a single
  // "● Writing app/index.tsx (12 lines)" line.
  const ui = createToolUi(
    existed ? 'editFile' : 'createFile',
    args.filePath,
    `(${lines} lines)`,
  );
  try {
    fs.writeFileSync(fullPath, args.content, 'utf-8');
    ui.succeed(`(${lines} lines)`);
  } catch (err) {
    ui.fail();
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

  if (session) session.recordOperation('update', args.filePath);

  const oldLines = args.oldText.split('\n').length;
  const newLines = args.newText.split('\n').length;
  const delta = newLines - oldLines;
  const extra =
    delta === 0
      ? undefined
      : delta > 0
        ? `(+${delta} lines)`
        : `(${delta} lines)`;

  const ui = createToolUi('editFile', args.filePath, extra);
  try {
    const newContent = content.replace(args.oldText, args.newText);
    fs.writeFileSync(fullPath, newContent, 'utf-8');
    ui.succeed(extra);
  } catch (err) {
    ui.fail();
    throw err;
  }

  return `Successfully edited ${args.filePath}`;
}

// ─── runCommand — streams live output via ToolUi ────────────────────────────

function isNpmFamily(cmd: string): boolean {
  const trimmed = cmd.trim();
  return /^(npm|npx|yarn|pnpm|bun(?:x)?)\b/.test(trimmed);
}

async function spawnWithLiveOutput(
  command: string,
  cwd: string,
  timeoutMs: number,
  onLine: (line: string) => void,
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
      if (captured.length > 32_000) captured = captured.slice(-16_000);
      lineBuf += text;
      const parts = lineBuf.split('\n');
      lineBuf = parts.pop() ?? '';
      for (const rawLine of parts) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        onLine(line);
      }
    };

    proc.stdout?.on('data', handleChunk);
    proc.stderr?.on('data', handleChunk);

    const timer = setTimeout(() => {
      onLine('(timeout — killing process)');
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
      if (lineBuf.trim()) onLine(lineBuf.trim());
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

  if (isNpmFamily(args.command)) {
    const status = ctx.installManager.getStatus();
    const isWaiting = status === 'installing' || status === 'pending';

    const ui = createToolUi(
      'runCommand',
      args.command,
      isWaiting ? '(waiting for base install)' : undefined,
    );

    try {
      const result = await ctx.installManager.runDependentCommand(
        args.command,
        timeoutMs,
        (line) => ui.progress(line),
        () => ui.update(args.command),
      );

      if (result.ok) ui.succeed();
      else ui.fail();

      const out = result.output;
      const truncated =
        out.length > 4000
          ? out.slice(0, 2000) + '\n...(truncated)...\n' + out.slice(-2000)
          : out;
      return result.ok ? truncated : `Error: ${truncated}`;
    } catch (err: any) {
      ui.fail();
      return `Error: ${err.message ?? 'unknown error'}`;
    }
  }

  const ui = createToolUi('runCommand', args.command);
  try {
    const result = await spawnWithLiveOutput(
      args.command,
      ctx.projectRoot,
      timeoutMs,
      (line) => ui.progress(line),
    );
    if (result.ok) ui.succeed();
    else ui.fail();
    const out = result.output;
    const truncated =
      out.length > 4000
        ? out.slice(0, 2000) + '\n...(truncated)...\n' + out.slice(-2000)
        : out;
    return result.ok ? truncated : `Error: ${truncated}`;
  } catch (err: any) {
    ui.fail();
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

  const ui = createToolUi('viewFile', args.filePath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const start = (args.startLine ?? 1) - 1;
  const end =
    args.endLine === -1 ? lines.length : (args.endLine ?? lines.length);
  const slice = lines.slice(Math.max(0, start), end);
  ui.succeed(`(${slice.length} lines)`);
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

  const ui = createToolUi('listDirectory', dirPath);

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
  ui.succeed(`(${result.length} entries)`);
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

  const ui = createToolUi('deleteFile', args.filePath);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) fs.rmdirSync(fullPath);
  else fs.unlinkSync(fullPath);
  ui.succeed();
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
  const ui = createToolUi('renameFile', label);
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(srcFull, destFull);
  ui.succeed();
  return `Successfully renamed ${args.oldPath} → ${args.newPath}`;
}

export async function executeSearchFiles(
  projectRoot: string,
  args: z.infer<typeof SearchFilesSchema>,
): Promise<string> {
  const maxResults = args.maxResults ?? 20;
  const ui = createToolUi('searchFiles', args.pattern);

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
        ui.succeed('(no matches)');
        resolve(`No matches found for "${args.pattern}"`);
        return;
      }
      const lines = trimmed.split('\n').slice(0, maxResults);
      ui.succeed(`(${lines.length} matches)`);
      resolve(`Found ${lines.length} match(es):\n` + lines.join('\n'));
    });
    proc.on('error', () => {
      ui.fail();
      resolve(`Search failed for pattern "${args.pattern}".`);
    });
  });
}

export function executeReadMultipleFiles(
  projectRoot: string,
  args: z.infer<typeof ReadMultipleFilesSchema>,
): string {
  const ui = createToolUi(
    'readMultipleFiles',
    `${args.filePaths.length} files`,
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
  ui.succeed();
  return results.join('\n\n');
}

export function executeAddEnvironmentVariables(
  args: z.infer<typeof AddEnvironmentVariablesSchema>,
): string {
  for (const name of args.envVarNames) {
    pendingEnvVars.add(name);
  }
  quickToolAction('addEnvironmentVariables', args.envVarNames.join(', '));
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
        quickToolAction('lookupDocs', skill);
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
