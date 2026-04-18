// src/utils/liveSpinner.ts
//
// A non-blocking live spinner that ticks continuously while work is running,
// and lets callers write log lines ABOVE the animated line without corrupting
// the display. The problem with the old implementation was:
//
//   1. It used a `while (Date.now() - start < waitMs)` busy-wait loop, which
//      BLOCKS the event loop — so no async work could progress and no streams
//      could emit during the "animation". The user saw a spinner but nothing
//      was actually happening.
//
//   2. It rewrote the same line with \r, so any `console.log` in between
//      would end up mid-spinner and corrupt the display.
//
// This implementation uses a real `setInterval`, clears the spinner line
// before writing other output (via `writeAbove`), and redraws it afterwards.
// A single global active spinner is tracked so nested or overlapping calls
// don't fight each other.

import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 80;

// Shimmer color cycle — gives the spinner life
const COLORS = [
  chalk.hex('#b89a00'), // darker gold (shadow)
  chalk.hex('#e6c200'),
  chalk.hex('#FAD40B'), // brand color (center highlight)
  chalk.hex('#ffe347'),
  chalk.hex('#fff1a3'),
  chalk.hex('#ffe347'),
];

export interface LiveSpinner {
  /** Update the spinner label while it's running. */
  update(text: string): void;
  /** Write a line above the spinner without corrupting it. */
  writeAbove(line: string): void;
  /** Stop the spinner silently. */
  stop(): void;
  /** Stop with a green checkmark and optional final message. */
  succeed(text?: string): void;
  /** Stop with a red cross and optional final message. */
  fail(text?: string): void;
  /** Stop with a yellow warning sign. */
  warn(text?: string): void;
  /** Is the spinner currently active? */
  readonly active: boolean;
}

let activeSpinner: InternalSpinner | null = null;

interface InternalSpinner extends LiveSpinner {
  _clearLine(): void;
  _redraw(): void;
}

/**
 * Start a live spinner. Only one spinner should be active at a time —
 * starting a new one automatically stops the previous (with a silent stop).
 */
export function startSpinner(initialText: string): LiveSpinner {
  // Enforce single active spinner — stop any existing one silently
  if (activeSpinner) {
    activeSpinner.stop();
  }

  let text = initialText;
  let frame = 0;
  let colorIdx = 0;
  let interval: NodeJS.Timeout | null = null;
  let stopped = false;
  let currentLineWidth = 0;

  const isTTY = process.stdout.isTTY === true;

  const render = () => {
    if (stopped) return;
    const color = COLORS[colorIdx % COLORS.length];
    const char = FRAMES[frame % FRAMES.length];
    const line = `  ${color(char)} ${text}`;
    // On non-TTY (CI, logs), just print once and skip animation
    if (!isTTY) {
      if (frame === 0) {
        process.stdout.write(line + '\n');
      }
      frame++;
      return;
    }
    // Clear and redraw
    process.stdout.write('\r\x1b[K' + line);
    currentLineWidth = stripAnsiLength(line);
    frame++;
    if (frame % 2 === 0) colorIdx++;
  };

  const clearLine = () => {
    if (!isTTY || stopped) return;
    process.stdout.write('\r\x1b[K');
    currentLineWidth = 0;
  };

  const spinner: InternalSpinner = {
    get active() {
      return !stopped;
    },
    update(newText: string) {
      text = newText;
      render();
    },
    writeAbove(line: string) {
      if (stopped) {
        process.stdout.write(line + '\n');
        return;
      }
      if (isTTY) {
        // Clear spinner line, write the log line, redraw spinner
        process.stdout.write('\r\x1b[K');
        process.stdout.write(line + '\n');
        render();
      } else {
        // Non-TTY: just append
        process.stdout.write(line + '\n');
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (isTTY) {
        process.stdout.write('\r\x1b[K');
      }
      if (activeSpinner === spinner) activeSpinner = null;
    },
    succeed(finalText?: string) {
      if (stopped) return;
      const label = finalText ?? text;
      spinner.stop();
      process.stdout.write(`  ${chalk.green('✓')} ${label}\n`);
    },
    fail(finalText?: string) {
      if (stopped) return;
      const label = finalText ?? text;
      spinner.stop();
      process.stdout.write(`  ${chalk.red('✗')} ${label}\n`);
    },
    warn(finalText?: string) {
      if (stopped) return;
      const label = finalText ?? text;
      spinner.stop();
      process.stdout.write(`  ${chalk.yellow('⚠')} ${label}\n`);
    },
    _clearLine: clearLine,
    _redraw: render,
  };

  activeSpinner = spinner;

  // Kick off the animation
  if (isTTY) {
    render();
    interval = setInterval(render, TICK_MS);
  } else {
    render(); // Print once for non-TTY
  }

  return spinner;
}

/**
 * Pause the currently active spinner (if any), run the callback, then
 * resume. Use this when you need to print multi-line output that isn't
 * going through writeAbove.
 */
export function pauseActiveSpinner<T>(fn: () => T): T {
  const s = activeSpinner;
  if (!s) return fn();
  s._clearLine();
  const result = fn();
  s._redraw();
  return result;
}

/** Get the currently active spinner for coordinating with other output. */
export function getActiveSpinner(): LiveSpinner | null {
  return activeSpinner;
}

/** Stop the active spinner if any (used on shutdown). */
export function stopActiveSpinner(): void {
  if (activeSpinner) activeSpinner.stop();
}

function stripAnsiLength(s: string): number {
  // Rough strip — good enough for knowing how many columns to clear
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
