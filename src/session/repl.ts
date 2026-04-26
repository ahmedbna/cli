// src/session/repl.ts
//
// Updated REPL. Two key changes from the original:
//
//   1. The FIRST turn (initial build) is dispatched to the multi-agent
//      orchestrator (Architect → Backend → Frontend), not runAgentTurn.
//   2. FOLLOW-UP turns continue to use the single-agent loop in agentTurn.ts
//      because they edit a small slice of an already-built app — the
//      multi-agent split adds overhead without benefit there.
//
// The orchestrator persists the Blueprint to .bna/blueprint.json so
// follow-up turns can read it as additional context.

import chalk from 'chalk';
import readline from 'readline';
import inquirer from 'inquirer';
import React from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { log } from '../utils/logger.js';
import { runAgentTurn } from './agentTurn.js';
import { runInitialBuildPipeline } from './orchestrator.js';
import { stopActiveSpinner } from '../utils/liveSpinner.js';
import { runFinalization } from '../commands/build.js';
import { getSkillMetadataForStack } from '../agent/skills.js';
import { checkCredits } from '../utils/credits.js';
import type { Session } from './session.js';
import type { TurnOutcome } from './planner.js';
import { App } from '../ui/App.js';
import { emit, setUiActive } from '../ui/events.js';
import { randomUUID } from 'node:crypto';

export interface ReplOptions {
  initialPrompt?: string;
  afterFirstTurn?: () => Promise<void>;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function runRepl(
  session: Session,
  opts: ReplOptions = {},
): Promise<void> {
  if (!process.stdout.isTTY) {
    return runLegacyRepl(session, opts);
  }

  // ── Controller state ──────────────────────────────────────────────────

  let agentRunning = false;
  let pendingInputResolver: ((text: string) => void) | null = null;
  let pendingClarifyResolver: ((answer: string) => void) | null = null;
  let pendingClarify: {
    id: string;
    question: string;
    options?: string[];
  } | null = null;

  let instance: InkInstance;

  const renderApp = () => {
    instance.rerender(
      React.createElement(App, {
        agentRunning,
        pendingClarify,
        onSubmit: (text: string) => {
          if (pendingInputResolver) {
            const resolver = pendingInputResolver;
            pendingInputResolver = null;
            resolver(text);
          }
        },
        onInterrupt: () => {
          if (agentRunning) {
            session.requestInterrupt();
            emit({ type: 'warn', text: 'Interrupting...' });
          }
        },
        onClarifyAnswer: (answer: string) => {
          if (pendingClarifyResolver) {
            const resolver = pendingClarifyResolver;
            pendingClarifyResolver = null;
            pendingClarify = null;
            resolver(answer);
            renderApp();
          }
        },
      }),
    );
  };

  const setAgentRunning = (v: boolean) => {
    agentRunning = v;
    renderApp();
  };

  const setPendingClarify = (
    c: { id: string; question: string; options?: string[] } | null,
  ) => {
    pendingClarify = c;
    renderApp();
  };

  setUiActive(true);

  instance = render(
    React.createElement(App, {
      agentRunning: false,
      pendingClarify: null,
      onSubmit: () => {},
      onInterrupt: () => {},
      onClarifyAnswer: () => {},
    }),
    { exitOnCtrlC: false },
  );
  renderApp();

  const waitForInput = (): Promise<string> =>
    new Promise((resolve) => {
      pendingInputResolver = resolve;
    });

  const waitForClarifyAnswer = (
    question: string,
    options?: string[],
  ): Promise<string> =>
    new Promise((resolve) => {
      const id = randomUUID();
      pendingClarifyResolver = (answer) => resolve(answer);
      setPendingClarify({ id, question, options });
    });

  // ── SIGINT handling ───────────────────────────────────────────────────

  let lastCtrlCAt = 0;
  const handleSigint = () => {
    const now = Date.now();
    if (agentRunning) {
      session.requestInterrupt();
      emit({
        type: 'warn',
        text: 'Interrupting... (ctrl-c again to force quit)',
      });
      lastCtrlCAt = now;
      return;
    }
    if (now - lastCtrlCAt < 2000) {
      session.persist();
      emit({ type: 'info', text: 'Goodbye.' });
      instance.unmount();
      process.exit(0);
    }
    emit({
      type: 'info',
      text: '(press ctrl-c again within 2s to exit, or /exit to quit)',
    });
    lastCtrlCAt = now;
  };
  process.on('SIGINT', handleSigint);

  // ── Drive turn ────────────────────────────────────────────────────────

  const driveTurn = async (
    userText: string,
    isInitialBuild: boolean,
  ): Promise<void> => {
    setAgentRunning(true);

    let outcome: TurnOutcome;
    try {
      if (isInitialBuild) {
        // Multi-agent pipeline. The orchestrator emits its own user/divider
        // events; we don't pre-emit the user message.
        outcome = await runInitialBuildPipeline(session, userText, {
          askUser: async (question, options) => {
            setAgentRunning(false);
            const ans = await waitForClarifyAnswer(question, options);
            setAgentRunning(true);
            return ans;
          },
        });
      } else {
        // Single-agent for follow-ups
        emit({ type: 'user', text: userText, ts: Date.now() });
        outcome = await runAgentTurn(session, userText, {
          isInitialBuild: false,
        });
      }
    } catch (err: any) {
      emit({
        type: 'error',
        text: `Turn failed: ${err.message ?? 'unknown error'}`,
      });
      setAgentRunning(false);
      return;
    }

    emit({ type: 'thinking-stop' });
    setAgentRunning(false);
    await handleOutcome(outcome);
  };

  const handleOutcome = async (outcome: TurnOutcome): Promise<void> => {
    switch (outcome.kind) {
      case 'complete':
        if (outcome.summary) emit({ type: 'success', text: outcome.summary });
        break;
      case 'clarify': {
        const answer = await waitForClarifyAnswer(
          outcome.question,
          outcome.options,
        );
        if (!answer.trim()) {
          emit({ type: 'info', text: '(no answer — paused)' });
          break;
        }
        emit({ type: 'user', text: answer, ts: Date.now() });
        setAgentRunning(true);
        const next = await runAgentTurn(session, answer);
        emit({ type: 'thinking-stop' });
        setAgentRunning(false);
        await handleOutcome(next);
        break;
      }
      case 'interrupted':
        emit({
          type: 'warn',
          text: 'Interrupted. Partial work saved. /undo to revert.',
        });
        break;
      case 'error':
        emit({ type: 'error', text: outcome.message });
        break;
    }
    session.persist();
  };

  // ── Initial prompt ────────────────────────────────────────────────────

  let firstPrompt = opts.initialPrompt;

  if (!firstPrompt) {
    firstPrompt = await waitForClarifyAnswer('What do you want to build?');
    if (!firstPrompt.trim()) {
      emit({ type: 'info', text: 'No prompt given. Exiting.' });
      setUiActive(false);
      instance.unmount();
      return;
    }
  }

  // First turn: multi-agent IF we don't already have a blueprint.
  // (Resumed sessions already have one — go straight to follow-up flow.)
  await driveTurn(firstPrompt, !session.hasBuilt());

  if (opts.afterFirstTurn) {
    try {
      await opts.afterFirstTurn();
    } catch (err: any) {
      emit({ type: 'warn', text: `Post-build hook failed: ${err.message}` });
    }
  }

  // ── Main loop ─────────────────────────────────────────────────────────

  try {
    while (true) {
      const text = (await waitForInput()).trim();
      if (!text) continue;

      if (text.startsWith('/')) {
        const shouldExit = await handleSlashCommand(session, text);
        if (shouldExit) break;
        continue;
      }

      await driveTurn(text, false);
    }
  } finally {
    process.removeListener('SIGINT', handleSigint);
    session.persist();
    setUiActive(false);
    instance.unmount();
    try {
      await instance.waitUntilExit();
    } catch {
      /* noop */
    }
  }
}

// ─── Slash commands (unchanged) ─────────────────────────────────────────────

async function handleSlashCommand(
  session: Session,
  input: string,
): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      emitHelp();
      return false;

    case 'exit':
    case 'quit':
    case 'q':
      emit({ type: 'info', text: 'Goodbye.' });
      return true;

    case 'status': {
      emit({
        type: 'info',
        text: `Project: ${session.projectRoot}  ·  Stack: ${session.stack}  ·  Turns: ${session.getTurnCount()}`,
      });
      const bp = session.getBlueprint();
      if (bp) {
        emit({
          type: 'info',
          text: chalk.dim(
            `  Blueprint: ${bp.meta.appName} · ${bp.screens.length} screens · ${bp.dataModel.length} tables · ${bp.apiContracts.length} APIs`,
          ),
        });
      }
      const ops = session.getRecentOperations(5);
      for (const op of ops) {
        emit({ type: 'info', text: `  #${op.id} ${op.kind} ${op.path}` });
      }
      return false;
    }

    case 'undo': {
      const entry = session.undoLastOperation();
      if (!entry) {
        emit({ type: 'warn', text: 'Nothing to undo.' });
        return false;
      }
      emit({
        type: 'success',
        text: `Undid #${entry.id}: ${entry.kind} ${entry.path}`,
      });
      return false;
    }

    case 'history': {
      const ops = session.getRecentOperations(20);
      if (ops.length === 0) {
        emit({ type: 'info', text: '(no operations yet)' });
        return false;
      }
      for (const op of ops) {
        emit({
          type: 'info',
          text: `  #${op.id}  ${op.kind.padEnd(7)} ${op.path}`,
        });
      }
      return false;
    }

    case 'blueprint': {
      const bp = session.getBlueprint();
      if (!bp) {
        emit({
          type: 'info',
          text: '(no blueprint — initial build has not run)',
        });
        return false;
      }
      emit({ type: 'info', text: `App: ${bp.meta.appName}` });
      emit({
        type: 'info',
        text: `Theme: ${bp.theme.palette} (${bp.theme.tone})`,
      });
      emit({
        type: 'info',
        text: `Screens: ${bp.screens.map((s) => s.name).join(', ')}`,
      });
      emit({
        type: 'info',
        text: `APIs: ${bp.apiContracts.map((a) => a.name).join(', ') || '(none)'}`,
      });
      return false;
    }

    case 'modify': {
      if (!arg) {
        emit({
          type: 'warn',
          text: 'Usage: /modify <description of what to change>',
        });
        return false;
      }
      emit({
        type: 'user',
        text: `Modify the existing app: ${arg}`,
        ts: Date.now(),
      });
      const outcome = await runAgentTurn(
        session,
        `Modify the existing app: ${arg}`,
      );
      emit({ type: 'thinking-stop' });
      if (outcome.kind === 'error')
        emit({ type: 'error', text: outcome.message });
      session.persist();
      return false;
    }

    case 'continue': {
      const outcome = await runAgentTurn(
        session,
        'Continue from where you left off. If the previous request is already complete, tell me so.',
      );
      emit({ type: 'thinking-stop' });
      if (outcome.kind === 'error')
        emit({ type: 'error', text: outcome.message });
      session.persist();
      return false;
    }

    case 'clear':
      console.clear();
      emit({ type: 'info', text: '(screen cleared)' });
      return false;

    case 'finalize':
      await runFinalization({
        session,
        stack: session.stack,
        installManager: session.installManager,
        authToken: session.getAuthToken(),
        skipRun: false,
      });
      return false;

    case 'skills':
      printSkillsInline(session);
      return false;

    case 'credits':
      await printCreditsInline();
      return false;

    default:
      emit({
        type: 'warn',
        text: `Unknown command: /${cmd}. Type /help for commands.`,
      });
      return false;
  }
}

function emitHelp(): void {
  const rows: Array<[string, string]> = [
    ['/help', 'show this help'],
    ['/status', 'show session state + recent changes'],
    ['/blueprint', "show the architect's plan"],
    ['/history', 'show last 20 file operations'],
    ['/undo', 'revert the most recent file operation'],
    ['/modify <desc>', 'ask the agent to modify the app'],
    ['/continue', 'pick up where the agent left off'],
    ['/finalize', 'run the finalization pipeline'],
    ['/skills', 'list skills available for this stack'],
    ['/credits', 'check your credit balance'],
    ['/clear', 'clear the screen'],
    ['/exit', 'save session and quit'],
  ];
  emit({ type: 'info', text: 'Commands:' });
  for (const [c, d] of rows) {
    emit({ type: 'info', text: `  ${c.padEnd(18)} ${d}` });
  }
  emit({
    type: 'info',
    text: 'Tips: press esc to interrupt · ctrl-c twice to exit',
  });
}

function printSkillsInline(session: Session): void {
  const skills = getSkillMetadataForStack(session.stack);
  if (skills.length === 0) {
    emit({ type: 'info', text: '(no skills available for this stack)' });
    return;
  }
  emit({
    type: 'info',
    text: `Skills available (${skills.length}) — loaded on demand:`,
  });
  const byTech = new Map<string, typeof skills>();
  for (const s of skills) {
    const bucket = byTech.get(s.tech) ?? [];
    bucket.push(s);
    byTech.set(s.tech, bucket);
  }
  for (const [tech, bucket] of byTech) {
    emit({ type: 'info', text: `  ${tech}` });
    for (const s of bucket) {
      emit({
        type: 'info',
        text: `    ${s.name.padEnd(30)} ${s.description}`,
      });
    }
  }
}

async function printCreditsInline(): Promise<void> {
  const { credits } = await checkCredits();
  if (credits < 0) {
    emit({
      type: 'warn',
      text: 'Could not fetch credits — check your connection.',
    });
  } else {
    emit({ type: 'info', text: `Credits: ${credits} remaining` });
  }
}

// ─── Legacy non-TTY REPL ────────────────────────────────────────────────────

async function runLegacyRepl(
  session: Session,
  opts: ReplOptions,
): Promise<void> {
  setUiActive(false);
  let agentRunning = false;
  let lastCtrlCAt = 0;

  const handleSigint = () => {
    const now = Date.now();
    if (agentRunning) {
      console.log();
      log.warn('Interrupting... (press Ctrl-C again to force exit)');
      session.requestInterrupt();
      lastCtrlCAt = now;
      return;
    }
    if (now - lastCtrlCAt < 2000) {
      console.log();
      log.info('Goodbye.');
      session.persist();
      process.exit(0);
    }
    console.log(chalk.dim('(press Ctrl-C again within 2s to exit)'));
    lastCtrlCAt = now;
  };
  process.on('SIGINT', handleSigint);

  if (opts.initialPrompt) {
    agentRunning = true;
    let outcome: TurnOutcome;
    if (!session.hasBuilt()) {
      outcome = await runInitialBuildPipeline(session, opts.initialPrompt, {
        askUser: async (question, options) => {
          console.log();
          console.log(chalk.bold.yellow('? ') + chalk.bold(question));
          if (options && options.length > 0) {
            const res = await inquirer.prompt([
              {
                type: 'list',
                name: 'answer',
                message: 'Choose:',
                choices: [...options, 'Something else...'],
              },
            ]);
            if (res.answer === 'Something else...') {
              const c = await inquirer.prompt([
                { type: 'input', name: 'answer', message: 'Your answer:' },
              ]);
              return c.answer;
            }
            return res.answer;
          }
          const r = await inquirer.prompt([
            { type: 'input', name: 'answer', message: 'Your answer:' },
          ]);
          return r.answer;
        },
      });
    } else {
      outcome = await runAgentTurn(session, opts.initialPrompt, {
        isInitialBuild: false,
      });
    }
    agentRunning = false;
    await legacyHandleOutcome(session, outcome);
    session.persist();
  }
  if (opts.afterFirstTurn) {
    try {
      await opts.afterFirstTurn();
    } catch (err: any) {
      log.warn(`Post-build hook failed: ${err.message}`);
    }
  }

  while (true) {
    let userInput: string;
    try {
      userInput = await legacyPrompt();
    } catch {
      break;
    }
    const trimmed = userInput.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const shouldExit = await handleSlashCommand(session, trimmed);
      if (shouldExit) break;
      continue;
    }

    agentRunning = true;
    try {
      const outcome = await runAgentTurn(session, trimmed);
      await legacyHandleOutcome(session, outcome);
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
}

async function legacyHandleOutcome(
  session: Session,
  outcome: TurnOutcome,
): Promise<void> {
  stopActiveSpinner();
  console.log();
  switch (outcome.kind) {
    case 'complete':
      if (outcome.summary) log.success(outcome.summary);
      else log.success('Done.');
      break;
    case 'clarify': {
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
            { type: 'input', name: 'custom', message: 'Your answer:' },
          ]);
          answer = custom.custom;
        } else answer = res.answer;
      } else {
        const res = await inquirer.prompt([
          { type: 'input', name: 'answer', message: 'Your answer:' },
        ]);
        answer = res.answer;
      }
      if (!answer.trim()) {
        log.info(chalk.dim('(no answer — paused)'));
        return;
      }
      const next = await runAgentTurn(session, answer);
      await legacyHandleOutcome(session, next);
      break;
    }
    case 'interrupted':
      log.warn('Interrupted. Partial work saved.');
      break;
    case 'error':
      log.error(outcome.message);
      break;
  }
}

function legacyPrompt(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(chalk.yellow('❯ '), (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => resolve(''));
    rl.on('SIGINT', () => {
      rl.close();
      resolve('');
    });
  });
}
