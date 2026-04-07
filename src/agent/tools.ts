// src/agent/tools.ts
// Tool definitions and executors for the CLI agent

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { log } from '../utils/logger.js';

export type ToolName = 'createFile' | 'runCommand' | 'viewFile' | 'listDirectory';

export const toolDefinitions = [
  {
    name: 'createFile' as const,
    description:
      'Create or overwrite a file on the local file system. The filePath is relative to the current project root. Always write the complete file content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file (e.g. "app/(home)/index.tsx")',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
        },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'runCommand' as const,
    description:
      'Execute a shell command in the project directory. Use for npm install, npx convex dev, etc. Returns stdout + stderr.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute (e.g. "npm install expo-camera")',
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
      'Read the contents of a file. Use before editing to know current state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file to read',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'listDirectory' as const,
    description:
      'List files and directories at the given path. Returns names with (dir) or (file) markers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dirPath: {
          type: 'string',
          description: 'Relative directory path (default ".")',
        },
      },
      required: [],
    },
  },
];

// ─── Tool Executors ─────────────────────────────────────────────────────────

export function executeCreateFile(
  projectRoot: string,
  args: { filePath: string; content: string }
): string {
  const fullPath = path.resolve(projectRoot, args.filePath);
  const dir = path.dirname(fullPath);

  fs.mkdirSync(dir, { recursive: true });

  const existed = fs.existsSync(fullPath);
  fs.writeFileSync(fullPath, args.content, 'utf-8');

  log.file(existed ? 'update' : 'create', args.filePath);
  return `Successfully ${existed ? 'updated' : 'created'} ${args.filePath}`;
}

export function executeRunCommand(
  projectRoot: string,
  args: { command: string; timeout?: number }
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
    return trimmed.length > 4000
      ? trimmed.slice(0, 2000) + '\n...(truncated)...\n' + trimmed.slice(-2000)
      : trimmed || '(command completed with no output)';
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    const stdout = err.stdout?.toString() ?? '';
    const combined = (stdout + '\n' + stderr).trim();
    return `Error (exit ${err.status ?? '?'}): ${combined.slice(0, 4000)}`;
  }
}

export function executeViewFile(
  projectRoot: string,
  args: { filePath: string }
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
  return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
}

export function executeListDirectory(
  projectRoot: string,
  args: { dirPath?: string }
): string {
  const fullPath = path.resolve(projectRoot, args.dirPath ?? '.');
  if (!fs.existsSync(fullPath)) {
    return `Error: Directory not found: ${args.dirPath ?? '.'}`;
  }
  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const filtered = entries.filter(
    (e) => !['node_modules', '.git', '.expo', '_generated'].includes(e.name)
  );
  return (
    'Directory:\n' +
    filtered
      .map((e) => `- ${e.name} (${e.isDirectory() ? 'dir' : 'file'})`)
      .join('\n')
  );
}

export function executeTool(
  projectRoot: string,
  toolName: ToolName,
  toolInput: Record<string, any>
): string {
  switch (toolName) {
    case 'createFile':
      return executeCreateFile(projectRoot, toolInput as any);
    case 'runCommand':
      return executeRunCommand(projectRoot, toolInput as any);
    case 'viewFile':
      return executeViewFile(projectRoot, toolInput as any);
    case 'listDirectory':
      return executeListDirectory(projectRoot, toolInput as any);
    default:
      return `Error: Unknown tool ${toolName}`;
  }
}
