// src/ui/toolAdapter.ts
//
// Tiny abstraction that lets tool executors work in either mode:
//
//   - UI active:   emits 'tool-start'/'tool-progress'/'tool-end' events
//   - UI inactive: uses the legacy liveSpinner with startSpinner + writeAbove
//
// Tool code does NOT need to know which mode it's in — it just calls:
//
//     const ui = createToolUi('editFile', 'app/index.tsx');
//     ui.progress('  wrote 12 lines');
//     ui.succeed('(+12/-0)');
//
// Keeping the old spinner-based display for the legacy path means
// everything that runs under --no-tty or in CI still shows exactly
// the same output it did before this UI rewrite.

import { randomUUID } from 'node:crypto';
import chalk, { type ChalkInstance } from 'chalk';
import { startSpinner, type LiveSpinner } from '../utils/liveSpinner.js';
import { emit, isUiActive } from './events.js';

export type ToolKind =
  | 'createFile'
  | 'editFile'
  | 'deleteFile'
  | 'renameFile'
  | 'viewFile'
  | 'readMultipleFiles'
  | 'listDirectory'
  | 'searchFiles'
  | 'runCommand'
  | 'lookupDocs'
  | 'addEnvironmentVariables'
  | 'checkDependencies';

export interface ToolUi {
  /** Streamed output line (e.g. from a child process) */
  progress(line: string): void;
  /** Update the short descriptor while the tool is still running */
  update(label: string, extra?: string): void;
  /** Successful finalization */
  succeed(extra?: string): void;
  /** Failure finalization */
  fail(extra?: string): void;
}

// Verb + color used when falling back to the legacy spinner.
// Matches (intentionally) the labels the old tools.ts used.
const LEGACY_STYLE: Record<
  ToolKind,
  { verb: string; color: ChalkInstance }
> = {
  createFile: { verb: 'Creating', color: chalk.green },
  editFile: { verb: 'Updating', color: chalk.yellow },
  deleteFile: { verb: 'Removing', color: chalk.red },
  renameFile: { verb: 'Moving', color: chalk.blue },
  viewFile: { verb: 'Reading', color: chalk.blue },
  readMultipleFiles: { verb: 'Reading', color: chalk.blue },
  listDirectory: { verb: 'Listing', color: chalk.blue },
  searchFiles: { verb: 'Searching', color: chalk.blue },
  runCommand: { verb: 'Running', color: chalk.magenta },
  lookupDocs: { verb: 'Loading skill', color: chalk.cyan },
  addEnvironmentVariables: { verb: 'Queued env', color: chalk.hex('#f59e0b') },
  checkDependencies: { verb: 'Checking deps', color: chalk.dim },
};

function legacyLabel(kind: ToolKind, label: string, extra?: string): string {
  const style = LEGACY_STYLE[kind];
  const tail = extra ? chalk.dim(` ${extra}`) : '';
  return `${style.color(style.verb)} ${chalk.cyan(label)}${tail}`;
}

/**
 * Open a UI channel for a tool call. Returns a ToolUi whose methods
 * transparently dispatch to either the event bus or the legacy spinner.
 *
 * Always pair a create with exactly one terminal call (succeed or fail).
 */
export function createToolUi(kind: ToolKind, label: string, extra?: string): ToolUi {
  if (isUiActive()) {
    const id = randomUUID();
    let currentExtra = extra;
    emit({ type: 'tool-start', id, name: kind, label, extra });
    return {
      progress(line: string) {
        // Skip empty lines — they just clutter the progress trail
        if (!line.trim()) return;
        emit({ type: 'tool-progress', id, line });
      },
      update(newLabel: string, newExtra?: string) {
        currentExtra = newExtra;
        // There's no mid-run update event; update by emitting a synthetic
        // progress line so the user sees the change. The more ambitious
        // option (sending a full tool-update event) wasn't necessary for
        // the current set of tools.
        emit({
          type: 'tool-progress',
          id,
          line: `→ ${newLabel}${newExtra ? ' ' + newExtra : ''}`,
        });
      },
      succeed(finalExtra?: string) {
        emit({
          type: 'tool-end',
          id,
          ok: true,
          extra: finalExtra ?? currentExtra,
        });
      },
      fail(finalExtra?: string) {
        emit({
          type: 'tool-end',
          id,
          ok: false,
          extra: finalExtra ?? currentExtra ?? 'failed',
        });
      },
    };
  }

  // Legacy path — keep the old spinner behavior byte-for-byte.
  const spinner: LiveSpinner = startSpinner(legacyLabel(kind, label, extra));
  let currentLabel = label;
  let currentExtra = extra;
  return {
    progress(line: string) {
      if (!line.trim()) return;
      spinner.writeAbove(chalk.dim('    │ ') + chalk.dim(line));
    },
    update(newLabel: string, newExtra?: string) {
      currentLabel = newLabel;
      currentExtra = newExtra;
      spinner.update(legacyLabel(kind, newLabel, newExtra));
    },
    succeed(finalExtra?: string) {
      spinner.succeed(
        legacyLabel(kind, currentLabel, finalExtra ?? currentExtra),
      );
    },
    fail(finalExtra?: string) {
      spinner.fail(
        legacyLabel(kind, currentLabel, finalExtra ?? currentExtra ?? 'failed'),
      );
    },
  };
}

/**
 * Convenience for one-shot "quick action" lines (no running/done lifecycle).
 * Emits a `tool-start` immediately followed by `tool-end` so it still looks
 * like a finalized tool line in the UI. Legacy path prints a single line.
 */
export function quickToolAction(
  kind: ToolKind,
  label: string,
  extra?: string,
): void {
  if (isUiActive()) {
    const id = randomUUID();
    emit({ type: 'tool-start', id, name: kind, label, extra });
    emit({ type: 'tool-end', id, ok: true, extra });
    return;
  }
  const style = LEGACY_STYLE[kind];
  const tail = extra ? chalk.dim(` ${extra}`) : '';
  process.stdout.write(
    `  ${style.color('✓')} ${style.color(style.verb)} ${chalk.cyan(label)}${tail}\n`,
  );
}
