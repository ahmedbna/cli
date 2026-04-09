// src/agent/tools.ts
// Tool definitions and executors for the CLI agent
// Streams file content to the terminal so users can see what's being written

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { log } from '../utils/logger.js';
import chalk from 'chalk';

export type ToolName =
  | 'createFile'
  | 'editFile'
  | 'runCommand'
  | 'viewFile'
  | 'listDirectory'
  | 'deleteFile'
  | 'renameFile'
  | 'searchFiles'
  | 'readMultipleFiles';

// ─── Tool Definitions (sent to Anthropic API) ────────────────────────────────

export const toolDefinitions = [
  {
    name: 'createFile' as const,
    description:
      'Create or overwrite a file on the local file system. The filePath is relative to the current project root. Always write the complete file content — no placeholders or "rest unchanged" comments.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description:
            'Relative path to the file (e.g. "app/(home)/index.tsx", "convex/schema.ts")',
        },
        content: {
          type: 'string',
          description: 'Full file content to write. Must be the complete file.',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'editFile' as const,
    description:
      'Replace a unique string in a file with new content. Use for targeted edits like bug fixes, adding imports, or modifying specific functions. The `oldText` must match exactly and appear only once in the file. Always use `viewFile` first to know current contents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file to edit',
        },
        oldText: {
          type: 'string',
          description:
            'The exact text to find and replace. Must be unique in the file and under 1024 chars.',
        },
        newText: {
          type: 'string',
          description: 'The replacement text. Under 1024 chars.',
        },
      },
      required: ['filePath', 'oldText', 'newText'],
    },
  },
  {
    name: 'runCommand' as const,
    description:
      'Execute a shell command in the project directory. Use for: npm install, npx convex dev --once, npx expo install <pkg>, etc. Returns stdout + stderr. Long-running commands time out at 120s.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command to execute (e.g. "npm install expo-camera")',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 120000)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'viewFile' as const,
    description:
      'Read the contents of a file. Use before editing to know current state. Returns numbered lines.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file to read',
        },
        startLine: {
          type: 'number',
          description:
            'Optional start line (1-indexed). Omit to read entire file.',
        },
        endLine: {
          type: 'number',
          description:
            'Optional end line (1-indexed, inclusive). Use -1 for end of file.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'listDirectory' as const,
    description:
      'List files and directories at the given path. Returns names with (dir) or (file) markers. Filters out node_modules, .git, .expo, _generated.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dirPath: {
          type: 'string',
          description: 'Relative directory path (default ".")',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list up to 2 levels deep (default false)',
        },
      },
      required: [],
    },
  },
  {
    name: 'deleteFile' as const,
    description: 'Delete a file or an empty directory from the file system.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file or directory to delete',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'renameFile' as const,
    description: 'Rename or move a file from one path to another.',
    input_schema: {
      type: 'object' as const,
      properties: {
        oldPath: {
          type: 'string',
          description: 'Current relative path of the file',
        },
        newPath: {
          type: 'string',
          description: 'New relative path for the file',
        },
      },
      required: ['oldPath', 'newPath'],
    },
  },
  {
    name: 'searchFiles' as const,
    description:
      'Search for a text pattern across project files. Returns matching file paths and line numbers. Useful for finding usages, imports, or specific code patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for',
        },
        fileGlob: {
          type: 'string',
          description:
            'Optional file glob to restrict search (e.g. "*.tsx", "convex/*.ts"). Default: all files.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default 20)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'readMultipleFiles' as const,
    description:
      'Read the contents of multiple files at once. More efficient than calling viewFile multiple times. Returns an object mapping each path to its content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of relative file paths to read',
        },
      },
      required: ['filePaths'],
    },
  },
];

// ─── Stream file content to terminal ─────────────────────────────────────────

const FILE_EXTENSIONS_WITH_SYNTAX: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TSX',
  '.js': 'JavaScript',
  '.jsx': 'JSX',
  '.json': 'JSON',
  '.css': 'CSS',
  '.md': 'Markdown',
  '.html': 'HTML',
};

function streamFileToTerminal(
  filePath: string,
  content: string,
  action: 'create' | 'update',
): void {
  const ext = path.extname(filePath);
  const lang = FILE_EXTENSIONS_WITH_SYNTAX[ext] ?? '';

  // Header
  const icon =
    action === 'create' ? chalk.green('+ CREATE') : chalk.yellow('~ UPDATE');
  const header = `${icon} ${chalk.cyan(filePath)}${lang ? chalk.dim(` (${lang})`) : ''}`;

  console.log();
  console.log(chalk.dim('┌─') + header);
  console.log(chalk.dim('│'));

  // Stream the content line by line with line numbers
  const lines = content.split('\n');
  const maxLineNum = String(lines.length).length;

  // If the file is huge, show first/last 30 lines
  const MAX_DISPLAY_LINES = 80;
  if (lines.length > MAX_DISPLAY_LINES) {
    const showTop = 30;
    const showBottom = 20;

    for (let i = 0; i < showTop; i++) {
      const lineNum = chalk.dim(String(i + 1).padStart(maxLineNum, ' '));
      console.log(
        chalk.dim('│ ') + lineNum + chalk.dim(' │ ') + chalk.white(lines[i]),
      );
    }

    console.log(
      chalk.dim('│ ') +
        chalk.dim('·'.padStart(maxLineNum, ' ')) +
        chalk.dim(' │ ') +
        chalk.dim(`... ${lines.length - showTop - showBottom} more lines ...`),
    );

    for (let i = lines.length - showBottom; i < lines.length; i++) {
      const lineNum = chalk.dim(String(i + 1).padStart(maxLineNum, ' '));
      console.log(
        chalk.dim('│ ') + lineNum + chalk.dim(' │ ') + chalk.white(lines[i]),
      );
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = chalk.dim(String(i + 1).padStart(maxLineNum, ' '));
      console.log(
        chalk.dim('│ ') + lineNum + chalk.dim(' │ ') + chalk.white(lines[i]),
      );
    }
  }

  console.log(chalk.dim('│'));
  console.log(chalk.dim('└─') + chalk.dim(` ${lines.length} lines`));
}

// ─── Tool Executors ─────────────────────────────────────────────────────────

export function executeCreateFile(
  projectRoot: string,
  args: { filePath: string; content: string },
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  fs.writeFileSync(fullPath, args.content, 'utf-8');

  // Stream file content to terminal so the user sees what's being written
  streamFileToTerminal(
    args.filePath,
    args.content,
    existed ? 'update' : 'create',
  );

  return `Successfully ${existed ? 'updated' : 'created'} ${args.filePath} (${args.content.split('\n').length} lines)`;
}

export function executeEditFile(
  projectRoot: string,
  args: { filePath: string; oldText: string; newText: string },
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

  // Show the edit in terminal
  console.log();
  console.log(chalk.yellow('~ EDIT') + ' ' + chalk.cyan(args.filePath));
  console.log(
    chalk.dim('  - ') + chalk.red(args.oldText.split('\n')[0].trim()),
  );
  console.log(
    chalk.dim('  + ') + chalk.green(args.newText.split('\n')[0].trim()),
  );
  if (args.oldText.includes('\n') || args.newText.includes('\n')) {
    const oldLines = args.oldText.split('\n').length;
    const newLines = args.newText.split('\n').length;
    console.log(chalk.dim(`    (${oldLines} lines → ${newLines} lines)`));
  }

  return `Successfully edited ${args.filePath}`;
}

export function executeRunCommand(
  projectRoot: string,
  args: { command: string; timeout?: number },
): string {
  log.command(args.command);
  try {
    const output = execSync(args.command, {
      cwd: projectRoot,
      timeout: args.timeout ?? 120_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const trimmed = output.trim();

    // Show truncated output in terminal
    if (trimmed) {
      const lines = trimmed.split('\n');
      if (lines.length > 20) {
        for (const line of lines.slice(0, 10)) {
          console.log(chalk.dim('  ') + line);
        }
        console.log(chalk.dim(`  ... ${lines.length - 15} more lines ...`));
        for (const line of lines.slice(-5)) {
          console.log(chalk.dim('  ') + line);
        }
      } else {
        for (const line of lines) {
          console.log(chalk.dim('  ') + line);
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
      const lines = combined.split('\n').slice(-10);
      for (const line of lines) {
        console.log(chalk.red('  ') + line);
      }
    }

    return `Error (exit ${err.status ?? '?'}): ${combined.slice(0, 4000)}`;
  }
}

export function executeViewFile(
  projectRoot: string,
  args: { filePath: string; startLine?: number; endLine?: number },
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
  args: { dirPath?: string; recursive?: boolean },
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
  args: { filePath: string },
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

  console.log(chalk.red('  ✕ Deleted: ') + chalk.dim(args.filePath));
  return `Successfully deleted ${args.filePath}`;
}

export function executeRenameFile(
  projectRoot: string,
  args: { oldPath: string; newPath: string },
): string {
  const srcFull = path.resolve(projectRoot, args.oldPath);
  const destFull = path.resolve(projectRoot, args.newPath);

  if (!fs.existsSync(srcFull)) {
    return `Error: Source file not found: ${args.oldPath}`;
  }

  // Ensure destination directory exists
  fs.mkdirSync(path.dirname(destFull), { recursive: true });
  fs.renameSync(srcFull, destFull);

  console.log(
    chalk.blue('  → Renamed: ') +
      chalk.dim(args.oldPath) +
      chalk.dim(' → ') +
      chalk.cyan(args.newPath),
  );
  return `Successfully renamed ${args.oldPath} → ${args.newPath}`;
}

export function executeSearchFiles(
  projectRoot: string,
  args: { pattern: string; fileGlob?: string; maxResults?: number },
): string {
  const maxResults = args.maxResults ?? 20;
  const results: string[] = [];

  // Use grep if available for speed, otherwise fallback to manual search
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
  args: { filePaths: string[] },
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

// ─── Tool Router ─────────────────────────────────────────────────────────────

export function executeTool(
  projectRoot: string,
  toolName: ToolName,
  toolInput: Record<string, any>,
): string {
  switch (toolName) {
    case 'createFile':
      return executeCreateFile(projectRoot, toolInput as any);
    case 'editFile':
      return executeEditFile(projectRoot, toolInput as any);
    case 'runCommand':
      return executeRunCommand(projectRoot, toolInput as any);
    case 'viewFile':
      return executeViewFile(projectRoot, toolInput as any);
    case 'listDirectory':
      return executeListDirectory(projectRoot, toolInput as any);
    case 'deleteFile':
      return executeDeleteFile(projectRoot, toolInput as any);
    case 'renameFile':
      return executeRenameFile(projectRoot, toolInput as any);
    case 'searchFiles':
      return executeSearchFiles(projectRoot, toolInput as any);
    case 'readMultipleFiles':
      return executeReadMultipleFiles(projectRoot, toolInput as any);
    default:
      return `Error: Unknown tool ${toolName}`;
  }
}
