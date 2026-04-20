// src/session/repl.ts
//
// The REPL is the user-facing chat loop. It:
//   - Reads user input line-by-line via readline
//   - Dispatches slash commands (/help, /undo, /status, /exit, etc.)
//   - Runs agent turns and handles their outcomes
//   - Manages Ctrl-C: first press interrupts the current turn,
//     second press within 2s exits the session
//   - Persists the session after each turn so `/continue` in a new
//     CLI invocation can pick up where you left off
//
// Slash commands are deliberately minimal — everything else is natural
// language that goes to the agent.

import chalk from 'chalk';
import readline from 'readline';
import inquirer from 'inquirer';
import { log } from '../utils/logger.js';
import { runAgentTurn } from './agentTurn.js';
import { stopActiveSpinner } from '../utils/liveSpinner.js';
import type { Session } from './session.js';
import type { TurnOutcome } from './planner.js';
import { runFinalization } from '../commands/build.js';

export interface ReplOptions {
  /** Whether this REPL was launched from a fresh `build` (first turn
   *  should be the initial build prompt) or resumed. */
  initialPrompt?: string;
  /** Called exactly once, after the first agent turn (from initialPrompt) completes */
  afterFirstTurn?: () => Promise<void>;
}

export async function runRepl(
  session: Session,
  opts: ReplOptions = {},
): Promise<void> {
  printWelcome(session);

  // ── Ctrl-C semantics ────────────────────────────────────────────────────
  //
  //   First Ctrl-C during an agent turn → request interrupt
  //   First Ctrl-C at the prompt        → hint "press again to exit"
  //   Second Ctrl-C within 2s           → exit the session
  //
  // This matches how tools like `node --interactive` and `claude` behave:
  // you can abort a generation without killing the whole session.

  let lastCtrlCAt = 0;
  let agentRunning = false;

  const handleSigint = () => {
    const now = Date.now();
    if (agentRunning) {
      console.log();
      log.warn('Interrupting... (press Ctrl-C again to force exit)');
      session.requestInterrupt();
      lastCtrlCAt = now;
      return;
    }
    // Not running an agent turn — user is at the prompt
    if (now - lastCtrlCAt < 2000) {
      console.log();
      log.info('Goodbye.');
      session.persist();
      process.exit(0);
    }
    console.log();
    console.log(
      chalk.dim('(press Ctrl-C again within 2s to exit, or /exit to quit)'),
    );
    lastCtrlCAt = now;
  };

  process.on('SIGINT', handleSigint);

  // ── If we were handed an initial prompt, kick off the first turn ────────
  if (opts.initialPrompt) {
    agentRunning = true;
    const outcome = await runAgentTurn(session, opts.initialPrompt, {
      isInitialBuild: true,
    });
    agentRunning = false;
    await handleOutcome(session, outcome);
    session.persist();
  }

  if (opts.afterFirstTurn) {
    try {
      await opts.afterFirstTurn();
    } catch (err: any) {
      log.warn(`Post-build hook failed: ${err.message}`);
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────
  while (true) {
    let userInput: string;
    try {
      userInput = await prompt(session);
    } catch {
      // readline closed (stdin ended)
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // Slash command?
    if (trimmed.startsWith('/')) {
      const shouldExit = await handleSlashCommand(session, trimmed);
      if (shouldExit) break;
      continue;
    }

    // Natural-language message → agent turn
    agentRunning = true;
    try {
      const outcome = await runAgentTurn(session, trimmed);
      await handleOutcome(session, outcome);
    } catch (err: any) {
      stopActiveSpinner();
      log.error(`Turn failed: ${err.message ?? 'unknown error'}`);
    } finally {
      agentRunning = false;
      session.persist();
    }
  }

  process.removeListener('SIGINT', handleSigint);
  session.persist();
  log.info('Session saved. Resume with ' + chalk.cyan('bna continue') + '.');
}

// ─── Outcome dispatcher ─────────────────────────────────────────────────────

async function handleOutcome(
  session: Session,
  outcome: TurnOutcome,
): Promise<void> {
  stopActiveSpinner();
  console.log();

  switch (outcome.kind) {
    case 'complete': {
      if (outcome.summary) {
        log.success(outcome.summary);
      } else {
        log.success(chalk.dim('Done.'));
      }
      showRecentChanges(session);
      break;
    }
    case 'clarify': {
      // The model paused and wants the user to answer. We ask inline
      // and feed the answer back as the next user turn automatically —
      // this preserves conversational flow.
      console.log(chalk.bold.yellow('? ') + chalk.bold(outcome.question));

      let answer: string;
      if (outcome.options && outcome.options.length > 0) {
        const res = await inquirer.prompt([
          {
            type: 'list',
            name: 'answer',
            message: 'Choose:',
            choices: [...outcome.options, 'Something else...'],
          },
        ]);
        if (res.answer === 'Something else...') {
          const custom = await inquirer.prompt([
            {
              type: 'input',
              name: 'custom',
              message: 'Your answer:',
            },
          ]);
          answer = custom.custom;
        } else {
          answer = res.answer;
        }
      } else {
        const res = await inquirer.prompt([
          { type: 'input', name: 'answer', message: 'Your answer:' },
        ]);
        answer = res.answer;
      }

      if (!answer.trim()) {
        log.info(chalk.dim('(no answer — pausing. Ask me again when ready.)'));
        return;
      }

      // Recursively feed back into a new agent turn.
      const next = await runAgentTurn(session, answer);
      await handleOutcome(session, next);
      break;
    }
    case 'interrupted': {
      log.warn('Interrupted. The partial work has been saved.');
      log.info(
        chalk.dim(
          'You can tell me what to do next, or use /undo to revert the last change.',
        ),
      );
      break;
    }
    case 'error': {
      log.error(outcome.message);
      break;
    }
  }
}

// ─── Slash commands ─────────────────────────────────────────────────────────

async function handleSlashCommand(
  session: Session,
  input: string,
): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      printHelp();
      return false;

    case 'exit':
    case 'quit':
    case 'q':
      log.info('Goodbye.');
      return true;

    case 'status': {
      log.info(chalk.bold('Session status'));
      log.info(`  Project:  ${chalk.cyan(session.projectRoot)}`);
      log.info(`  Stack:    ${chalk.cyan(session.stack)}`);
      log.info(`  Turns:    ${chalk.cyan(String(session.getTurnCount()))}`);
      const ops = session.getRecentOperations(5);
      log.info(`  Recent changes: ${ops.length}`);
      for (const op of ops) {
        log.info(
          chalk.dim('    ') +
            chalk.dim(`#${op.id} `) +
            formatOp(op.kind) +
            ' ' +
            chalk.cyan(op.path),
        );
      }
      return false;
    }

    case 'undo': {
      const entry = session.undoLastOperation();
      if (!entry) {
        log.warn('Nothing to undo.');
        return false;
      }
      log.success(
        `Undid #${entry.id}: ${formatOp(entry.kind)} ${chalk.cyan(entry.path)}`,
      );
      return false;
    }

    case 'history': {
      const ops = session.getRecentOperations(20);
      if (ops.length === 0) {
        log.info(chalk.dim('(no operations yet)'));
        return false;
      }
      log.info(chalk.bold(`Last ${ops.length} operation(s):`));
      for (const op of ops) {
        const when = new Date(op.timestamp).toLocaleTimeString();
        log.info(
          chalk.dim(`  #${op.id} ${when}  `) +
            formatOp(op.kind) +
            ' ' +
            chalk.cyan(op.path),
        );
      }
      return false;
    }

    case 'modify': {
      if (!arg) {
        log.warn('Usage: /modify <description of what to change>');
        return false;
      }
      // Turn this into a natural agent turn with a slight prefix
      const outcome = await runAgentTurn(
        session,
        `Modify the existing app: ${arg}`,
      );
      await handleOutcome(session, outcome);
      session.persist();
      return false;
    }

    case 'continue': {
      // Ask the agent to pick up whatever it was working on
      const outcome = await runAgentTurn(
        session,
        'Continue from where you left off. If the previous request is already complete, tell me so.',
      );
      await handleOutcome(session, outcome);
      session.persist();
      return false;
    }

    case 'clear':
      console.clear();
      printWelcome(session);
      return false;

    case 'finalize': {
      await runFinalization({
        session,
        stack: session.stack,
        installManager: session.installManager,
        authToken: session.getAuthToken(),
        skipRun: false,
      });
      return false;
    }

    default:
      log.warn(`Unknown command: /${cmd}. Type /help for available commands.`);
      return false;
  }
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

function printWelcome(session: Session): void {
  console.log();
  console.log(
    chalk.yellow.bold('BNA') + chalk.dim(' — conversational build session'),
  );
  console.log(chalk.dim(`  Project: ${session.projectRoot}`));
  console.log(chalk.dim(`  Stack:   ${session.stack}`));
  console.log();
  console.log(
    chalk.dim('Type anything to chat. ') +
      chalk.cyan('/help') +
      chalk.dim(' for commands, ') +
      chalk.cyan('/exit') +
      chalk.dim(' to quit.'),
  );
  console.log();
}

function printHelp(): void {
  const rows: Array<[string, string]> = [
    ['/help', 'show this help'],
    ['/status', 'show session state and recent changes'],
    ['/history', 'show last 20 file operations'],
    ['/undo', 'revert the most recent file operation'],
    ['/modify <description>', 'ask the agent to modify the app'],
    ['/continue', 'pick up from where the agent left off'],
    ['/clear', 'clear the screen'],
    ['/exit', 'save the session and quit'],
  ];
  console.log();
  log.info(chalk.bold('Commands'));
  for (const [cmd, desc] of rows) {
    console.log('  ' + chalk.cyan(cmd.padEnd(24)) + chalk.dim(desc));
  }
  console.log();
  log.info(chalk.bold('Tips'));
  console.log(
    chalk.dim(
      "  • Anything that isn't a /command becomes a message to the agent.",
    ),
  );
  console.log(
    chalk.dim('  • Press Ctrl-C once to interrupt the agent mid-task.'),
  );
  console.log(
    chalk.dim('  • Press Ctrl-C twice within 2s (at the prompt) to exit.'),
  );
  console.log();
}

function showRecentChanges(session: Session): void {
  const ops = session.getRecentOperations(5);
  if (ops.length === 0) return;
  // We already showed file operations live via the spinner. Here we
  // just give a compact tail summary so the user sees the bottom line.
  const fresh = ops.filter((o) => Date.now() - o.timestamp < 30_000);
  if (fresh.length === 0) return;
  console.log(chalk.dim(`  (${fresh.length} file(s) changed this turn)`));
}

function formatOp(kind: string): string {
  switch (kind) {
    case 'create':
      return chalk.green('created');
    case 'update':
      return chalk.yellow('updated');
    case 'delete':
      return chalk.red('deleted');
    case 'rename':
      return chalk.blue('renamed');
    default:
      return kind;
  }
}

// ─── Prompt (readline) ──────────────────────────────────────────────────────

function prompt(session: Session): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const marker = chalk.yellow('❯ ');
    rl.question(marker, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => {
      // If the user hit Ctrl-D, readline closes without calling the
      // question callback — reject so the main loop can exit cleanly.
      resolve('');
    });
    rl.on('SIGINT', () => {
      // Let the outer SIGINT handler deal with it; just close the line.
      rl.close();
      resolve('');
    });
  });
}
