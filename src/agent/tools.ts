// src/agent/tools.ts
// Tool definitions and executors for the CLI agent.
//
// Refactored to use:
// - Zod schemas as the single source of truth for tool inputs
// - z.toJSONSchema() to generate Anthropic API input_schema
// - Skills-based documentation lookup (replaces lookupConvexDocs + lookupExpoDocs)

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk, { type ChalkInstance } from 'chalk';
import { z } from 'zod';
import { executeLookupDocs, SKILL_REGISTRY, SKILL_NAMES } from './skills.js';

// ─── Zod Schemas (single source of truth) ────────────────────────────────────

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
    .describe('Timeout in milliseconds (default 120000)'),
});

export const ViewFileSchema = z.object({
  filePath: z.string().describe('Relative path to the file to read'),
  startLine: z
    .number()
    .optional()
    .describe('Optional start line (1-indexed). Omit to read entire file.'),
  endLine: z
    .number()
    .optional()
    .describe(
      'Optional end line (1-indexed, inclusive). Use -1 for end of file.',
    ),
});

export const ListDirectorySchema = z.object({
  dirPath: z
    .string()
    .optional()
    .describe('Relative directory path (default ".")'),
  recursive: z
    .boolean()
    .optional()
    .describe('If true, list up to 2 levels deep (default false)'),
});

export const DeleteFileSchema = z.object({
  filePath: z
    .string()
    .describe('Relative path to the file or directory to delete'),
});

export const RenameFileSchema = z.object({
  oldPath: z.string().describe('Current relative path of the file'),
  newPath: z.string().describe('New relative path for the file'),
});

export const SearchFilesSchema = z.object({
  pattern: z.string().describe('Text or regex pattern to search for'),
  fileGlob: z
    .string()
    .optional()
    .describe(
      'Optional file glob to restrict search (e.g. "*.tsx", "convex/*.ts"). Default: all files.',
    ),
  maxResults: z
    .number()
    .optional()
    .describe('Maximum number of results to return (default 20)'),
});

export const ReadMultipleFilesSchema = z.object({
  filePaths: z
    .array(z.string())
    .describe('Array of relative file paths to read'),
});

// Build the valid topics enum dynamically from the skill registry
const allTopicValues = Object.values(SKILL_REGISTRY).flatMap((s) => s.topics);

export const LookupDocsSchema = z.object({
  skill: z
    .enum(SKILL_NAMES as [string, ...string[]])
    .describe(
      `Documentation skill to look up. Available: ${SKILL_NAMES.join(', ')}`,
    ),
  topics: z.array(z.string()).describe(
    `Specific topics to read. Leave empty to get the skill overview. ` +
      Object.entries(SKILL_REGISTRY)
        .map(([name, { topics }]) => `${name}: ${topics.join(', ')}`)
        .join('. '),
  ),
});

export const AddEnvironmentVariablesSchema = z.object({
  envVarNames: z
    .array(z.string())
    .describe(
      'List of environment variable names to add (e.g. ["OPENAI_API_KEY", "STRIPE_SECRET_KEY"])',
    ),
});

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
  | 'addEnvironmentVariables';

// ─── Tool Definitions (sent to Anthropic API) ────────────────────────────────
// Generated from Zod schemas using z.toJSONSchema()

function toolDef(name: string, description: string, schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema);
  // Anthropic expects { type: 'object', properties: {...}, required: [...] }
  // z.toJSONSchema wraps in a $schema — extract the relevant parts
  const { $schema, ...rest } = jsonSchema as any;
  return { name, description, input_schema: rest };
}

export const toolDefinitions = [
  toolDef(
    'createFile',
    'Create or overwrite a file on the local file system. The filePath is relative to the current project root. Always write the complete file content — no placeholders or "rest unchanged" comments.',
    CreateFileSchema,
  ),
  toolDef(
    'editFile',
    'Replace a unique string in a file with new content. Use for targeted edits like bug fixes, adding imports, or modifying specific functions. The `oldText` must match exactly and appear only once in the file. Always use `viewFile` first to know current contents.',
    EditFileSchema,
  ),
  toolDef(
    'runCommand',
    'Execute a shell command in the project directory. Use ONLY for: `npx expo install <pkg>` when adding packages not in the template. Returns stdout + stderr. Long-running commands time out at 120s.',
    RunCommandSchema,
  ),
  toolDef(
    'viewFile',
    'Read the contents of a file. Use before editing to know current state. Returns numbered lines.',
    ViewFileSchema,
  ),
  toolDef(
    'listDirectory',
    'List files and directories at the given path. Returns names with (dir) or (file) markers. Filters out node_modules, .git, .expo, _generated.',
    ListDirectorySchema,
  ),
  toolDef(
    'deleteFile',
    'Delete a file or an empty directory from the file system.',
    DeleteFileSchema,
  ),
  toolDef(
    'renameFile',
    'Rename or move a file from one path to another.',
    RenameFileSchema,
  ),
  toolDef(
    'searchFiles',
    'Search for a text pattern across project files. Returns matching file paths and line numbers. Useful for finding usages, imports, or specific code patterns.',
    SearchFilesSchema,
  ),
  toolDef(
    'readMultipleFiles',
    'Read the contents of multiple files at once. More efficient than calling viewFile multiple times. Returns an object mapping each path to its content.',
    ReadMultipleFilesSchema,
  ),
  toolDef(
    'lookupDocs',
    'Look up documentation for advanced Convex or Expo features BEFORE implementing them. ' +
      'Reads from bundled skill reference files. Always call this before writing code for: ' +
      'file storage, full-text search, pagination, HTTP actions, scheduling/crons, Node.js actions, ' +
      'TypeScript types, function calling, advanced queries/mutations, presence, ' +
      'dev builds, EAS builds, routing, image/media, animations, haptics/gestures.',
    LookupDocsSchema,
  ),
  toolDef(
    'addEnvironmentVariables',
    'Instruct the user to add environment variables to their Convex deployment. Use this when the app requires API keys or secrets (e.g. OPENAI_API_KEY, STRIPE_SECRET_KEY). The tool returns instructions for the user to set these variables via the Convex dashboard or CLI.',
    AddEnvironmentVariablesSchema,
  ),
];

// ─── Shimmer animation for action labels ─────────────────────────────────────

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

  // Block until animation completes
  const waitMs = totalFrames * 60 + 20;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    // busy-wait to keep the animation visible
  }
}

function showActionLabel(
  action: 'create' | 'update' | 'delete' | 'rename' | 'run' | 'docs' | 'env',
  filePath: string,
  lines?: number,
): void {
  const labels: Record<string, { verb: string; color: ChalkInstance }> = {
    create: { verb: 'Creating', color: chalk.green },
    update: { verb: 'Updating', color: chalk.yellow },
    delete: { verb: 'Removing', color: chalk.red },
    rename: { verb: 'Moving', color: chalk.blue },
    run: { verb: 'Running', color: chalk.magenta },
    docs: { verb: 'Looking up', color: chalk.cyan },
    env: { verb: 'Environment', color: chalk.hex('#f59e0b') },
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
    return `Error: The specified text appears ${occurrences} times in ${args.filePath}. It must be unique. Use a larger or more specific text fragment.`;
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

export function executeRunCommand(
  projectRoot: string,
  args: z.infer<typeof RunCommandSchema>,
): string {
  showActionLabel('run', args.command);
  try {
    const output = execSync(args.command, {
      cwd: projectRoot,
      timeout: args.timeout ?? 120_000,
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
  if (!fs.existsSync(fullPath)) {
    return `Error: File not found: ${args.filePath}`;
  }
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
  if (!fs.existsSync(fullPath)) {
    return `Error: File not found: ${args.filePath}`;
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    fs.rmdirSync(fullPath);
  } else {
    fs.unlinkSync(fullPath);
  }

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

    if (!output) {
      return `No matches found for "${args.pattern}"`;
    }

    const lines = output.split('\n').slice(0, maxResults);
    return `Found ${lines.length} match(es):\n` + lines.join('\n');
  } catch {
    return `Search failed for pattern "${args.pattern}". The pattern may be invalid.`;
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

// ─── Environment Variables Executor ──────────────────────────────────────────

export function executeAddEnvironmentVariables(
  _projectRoot: string,
  args: z.infer<typeof AddEnvironmentVariablesSchema>,
): string {
  const names = args.envVarNames;

  showActionLabel('env', names.join(', '));

  const instructions = names
    .map(
      (name) =>
        `  • ${name}\n    Set via dashboard: Convex Dashboard → Settings → Environment Variables\n    Or via CLI: npx convex env set ${name} <value>`,
    )
    .join('\n\n');

  return (
    `The following environment variables need to be set on your Convex deployment:\n\n` +
    instructions +
    `\n\nPlease set these before using features that depend on them.`
  );
}

// ─── Tool Router ─────────────────────────────────────────────────────────────

export function executeTool(
  projectRoot: string,
  toolName: ToolName,
  toolInput: Record<string, any>,
): string {
  switch (toolName) {
    case 'createFile':
      return executeCreateFile(
        projectRoot,
        toolInput as z.infer<typeof CreateFileSchema>,
      );
    case 'editFile':
      return executeEditFile(
        projectRoot,
        toolInput as z.infer<typeof EditFileSchema>,
      );
    case 'runCommand':
      return executeRunCommand(
        projectRoot,
        toolInput as z.infer<typeof RunCommandSchema>,
      );
    case 'viewFile':
      return executeViewFile(
        projectRoot,
        toolInput as z.infer<typeof ViewFileSchema>,
      );
    case 'listDirectory':
      return executeListDirectory(
        projectRoot,
        toolInput as z.infer<typeof ListDirectorySchema>,
      );
    case 'deleteFile':
      return executeDeleteFile(
        projectRoot,
        toolInput as z.infer<typeof DeleteFileSchema>,
      );
    case 'renameFile':
      return executeRenameFile(
        projectRoot,
        toolInput as z.infer<typeof RenameFileSchema>,
      );
    case 'searchFiles':
      return executeSearchFiles(
        projectRoot,
        toolInput as z.infer<typeof SearchFilesSchema>,
      );
    case 'readMultipleFiles':
      return executeReadMultipleFiles(
        projectRoot,
        toolInput as z.infer<typeof ReadMultipleFilesSchema>,
      );
    case 'lookupDocs': {
      const args = toolInput as z.infer<typeof LookupDocsSchema>;
      showActionLabel(
        'docs',
        `${args.skill}: ${args.topics.join(', ') || 'overview'}`,
      );
      return executeLookupDocs(args);
    }
    case 'addEnvironmentVariables':
      return executeAddEnvironmentVariables(
        projectRoot,
        toolInput as z.infer<typeof AddEnvironmentVariablesSchema>,
      );
    default:
      return `Error: Unknown tool ${toolName}`;
  }
}
