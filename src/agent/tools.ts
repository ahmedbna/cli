// src/agent/tools.ts
// Tool definitions and executors for the CLI agent
// Shows animated action labels instead of streaming full file content

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import chalk, { type ChalkInstance } from 'chalk';

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
  action: 'create' | 'update' | 'delete' | 'rename' | 'run',
  filePath: string,
  lines?: number,
): void {
  const labels: Record<string, { verb: string; color: ChalkInstance }> = {
    create: { verb: 'Creating', color: chalk.green },
    update: { verb: 'Updating', color: chalk.yellow },
    delete: { verb: 'Removing', color: chalk.red },
    rename: { verb: 'Moving', color: chalk.blue },
    run: { verb: 'Running', color: chalk.magenta },
  };

  const { verb, color } = labels[action];
  const lineInfo = lines ? chalk.dim(` (${lines} lines)`) : '';
  const label = `${verb} ${chalk.cyan(filePath)}${lineInfo}`;

  shimmerText(label, color);
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

  const lines = args.content.split('\n').length;

  // Show animated action label instead of streaming file content
  showActionLabel(existed ? 'update' : 'create', args.filePath, lines);

  return `Successfully ${existed ? 'updated' : 'created'} ${args.filePath} (${lines} lines)`;
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

  // Show animated action label
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
  args: { command: string; timeout?: number },
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

    // Show truncated output in terminal (keep minimal)
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

  showActionLabel('delete', args.filePath);
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

  showActionLabel('rename', `${args.oldPath} → ${args.newPath}`);
  return `Successfully renamed ${args.oldPath} → ${args.newPath}`;
}

export function executeSearchFiles(
  projectRoot: string,
  args: { pattern: string; fileGlob?: string; maxResults?: number },
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
