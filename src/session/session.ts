// src/session/session.ts
//
// Session holds ALL persistent state for a conversational CLI session:
//   - Conversation history (via ContextManager)
//   - File operation journal (for `undo last step`)
//   - Installed packages / env vars queued
//   - Stack + project root
//   - A serializable snapshot for `continue` across CLI restarts
//
// The Session is the single source of truth. The REPL reads from it and
// writes to it. Agent turns are ephemeral operations that mutate it.

import fs from 'fs';
import path from 'path';
import { ContextManager } from '../agent/contextManager.js';
import type { InstallManager } from '../utils/installManager.js';

export interface FileJournalEntry {
  /** Monotonic step id */
  id: number;
  timestamp: number;
  kind: 'create' | 'update' | 'delete' | 'rename';
  path: string;
  /** Contents BEFORE this operation, so we can restore on undo.
   *  null means the file did not exist before (creation). */
  previousContent: string | null;
  /** For rename: the new path */
  renamedTo?: string;
}

export interface SessionSnapshot {
  projectRoot: string;
  stack: 'expo' | 'expo-convex';
  createdAt: number;
  turns: number;
  journal: FileJournalEntry[];
  /** Serialized ContextManager state */
  messages: any[];
  /** Initial build prompt, for reference */
  initialPrompt: string;
  /** Env vars the user has confirmed are set on the deployment */
  confirmedEnvVars: string[];
}

export class Session {
  readonly projectRoot: string;
  readonly stack: 'expo' | 'expo-convex';
  readonly initialPrompt: string;
  readonly context: ContextManager;
  readonly installManager: InstallManager;

  /** Incrementing step counter for journal entries */
  private nextStepId = 1;
  /** File operations, most recent last */
  private journal: FileJournalEntry[] = [];
  /** Turn count (one turn = one user input round) */
  private turnCount = 0;
  /** Auth token (refreshed over the session's lifetime) */
  private authToken: string;
  /** Env vars confirmed as set */
  private confirmedEnvVars = new Set<string>();
  /** Whether the current agent turn should be interrupted */
  private interruptRequested = false;
  /** Listener hooks */
  private onJournalListeners = new Set<(entry: FileJournalEntry) => void>();

  constructor(opts: {
    projectRoot: string;
    stack: 'expo' | 'expo-convex';
    initialPrompt: string;
    authToken: string;
    installManager: InstallManager;
  }) {
    this.projectRoot = opts.projectRoot;
    this.stack = opts.stack;
    this.initialPrompt = opts.initialPrompt;
    this.authToken = opts.authToken;
    this.installManager = opts.installManager;
    this.context = new ContextManager({
      keepRecentRounds: 3,
      toolResultMaxChars: 400,
      createFileContentMaxChars: 200,
      viewDedupWindow: 4,
    });
  }

  // ── Auth ───────────────────────────────────────────────────────────────

  getAuthToken(): string {
    return this.authToken;
  }

  setAuthToken(token: string): void {
    this.authToken = token;
  }

  // ── Turn tracking ──────────────────────────────────────────────────────

  beginTurn(): number {
    this.turnCount++;
    this.interruptRequested = false;
    return this.turnCount;
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  // ── Interrupt handling ─────────────────────────────────────────────────

  requestInterrupt(): void {
    this.interruptRequested = true;
  }

  isInterruptRequested(): boolean {
    return this.interruptRequested;
  }

  clearInterrupt(): void {
    this.interruptRequested = false;
  }

  // ── File journal ───────────────────────────────────────────────────────
  //
  // The journal lets us answer "what did the agent just do?" and
  // implement `undo last step`. We capture the prior file state BEFORE
  // a write so undo is deterministic.

  /**
   * Record a filesystem operation. MUST be called before the operation
   * actually happens, with the content as it exists on disk *now*.
   */
  recordOperation(kind: FileJournalEntry['kind'], filePath: string): number {
    const absPath = path.resolve(this.projectRoot, filePath);
    let previousContent: string | null = null;

    if (kind === 'create' || kind === 'update' || kind === 'delete') {
      if (fs.existsSync(absPath)) {
        try {
          const stat = fs.statSync(absPath);
          if (stat.isFile()) {
            previousContent = fs.readFileSync(absPath, 'utf-8');
          }
        } catch {
          /* ignore */
        }
      }
    }

    const entry: FileJournalEntry = {
      id: this.nextStepId++,
      timestamp: Date.now(),
      kind,
      path: filePath,
      previousContent,
    };
    this.journal.push(entry);
    for (const l of this.onJournalListeners) {
      try {
        l(entry);
      } catch {
        /* noop */
      }
    }
    return entry.id;
  }

  recordRename(oldPath: string, newPath: string): number {
    const entry: FileJournalEntry = {
      id: this.nextStepId++,
      timestamp: Date.now(),
      kind: 'rename',
      path: oldPath,
      renamedTo: newPath,
      previousContent: null,
    };
    this.journal.push(entry);
    return entry.id;
  }

  /** Get the N most recent journal entries */
  getRecentOperations(n = 10): FileJournalEntry[] {
    return this.journal.slice(-n);
  }

  /**
   * Undo the last operation. Returns a summary, or null if nothing to undo.
   */
  undoLastOperation(): FileJournalEntry | null {
    const entry = this.journal.pop();
    if (!entry) return null;

    const absPath = path.resolve(this.projectRoot, entry.path);

    switch (entry.kind) {
      case 'create':
        // File didn't exist before — remove it
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        break;
      case 'update':
        // Restore previous content
        if (entry.previousContent !== null) {
          fs.writeFileSync(absPath, entry.previousContent, 'utf-8');
        }
        break;
      case 'delete':
        // Recreate the file
        if (entry.previousContent !== null) {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, entry.previousContent, 'utf-8');
        }
        break;
      case 'rename':
        if (entry.renamedTo) {
          const newAbs = path.resolve(this.projectRoot, entry.renamedTo);
          if (fs.existsSync(newAbs)) {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.renameSync(newAbs, absPath);
          }
        }
        break;
    }

    return entry;
  }

  onOperation(listener: (entry: FileJournalEntry) => void): () => void {
    this.onJournalListeners.add(listener);
    return () => this.onJournalListeners.delete(listener);
  }

  // ── Env vars ───────────────────────────────────────────────────────────

  markEnvVarConfirmed(name: string): void {
    this.confirmedEnvVars.add(name);
  }

  getConfirmedEnvVars(): string[] {
    return Array.from(this.confirmedEnvVars);
  }

  // ── Persistence ────────────────────────────────────────────────────────
  //
  // We persist the session under .bna/session.json inside the project,
  // so `bna build` in an existing project directory can offer to resume.

  snapshot(): SessionSnapshot {
    return {
      projectRoot: this.projectRoot,
      stack: this.stack,
      createdAt: Date.now(),
      turns: this.turnCount,
      journal: this.journal,
      messages: this.context.getMessages(),
      initialPrompt: this.initialPrompt,
      confirmedEnvVars: Array.from(this.confirmedEnvVars),
    };
  }

  persist(): void {
    const dir = path.join(this.projectRoot, '.bna');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.json');
    fs.writeFileSync(file, JSON.stringify(this.snapshot(), null, 2), 'utf-8');
  }

  static tryLoad(projectRoot: string): SessionSnapshot | null {
    const file = path.join(projectRoot, '.bna', 'session.json');
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Restore context + journal from a snapshot (used by `continue`). */
  restoreFrom(snapshot: SessionSnapshot): void {
    this.turnCount = snapshot.turns;
    this.journal = snapshot.journal;
    this.nextStepId = Math.max(0, ...this.journal.map((e) => e.id)) + 1;
    for (const name of snapshot.confirmedEnvVars) {
      this.confirmedEnvVars.add(name);
    }
    // Rehydrate context manager by replaying messages
    if (snapshot.messages.length > 0) {
      const first = snapshot.messages[0];
      if (typeof first.content === 'string') {
        this.context.setInitialMessage(first.content);
      }
      for (let i = 1; i < snapshot.messages.length; i++) {
        const msg = snapshot.messages[i];
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          this.context.addAssistantMessage(msg.content);
        } else if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            this.context.addUserText(msg.content);
          } else if (Array.isArray(msg.content)) {
            // tool_result blocks
            this.context.addToolResults(msg.content);
          }
        }
      }
    }
  }
}
