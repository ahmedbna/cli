// src/session/session.ts
//
// Session holds ALL persistent state for a conversational CLI session:
//   - Conversation history (via ContextManager) — used for FOLLOW-UP turns only
//   - Blueprint (the architect's plan) — produced once by the orchestrator
//   - File operation journal (for `/undo`)
//   - Installed packages / env vars queued
//   - Stack + project root
//   - A serializable snapshot for resuming across CLI restarts

import fs from 'fs';
import path from 'path';
import { ContextManager } from '../agent/contextManager.js';
import type { InstallManager } from '../utils/installManager.js';
import type { Blueprint } from '../agent/blueprint.js';

export interface FileJournalEntry {
  id: number;
  timestamp: number;
  kind: 'create' | 'update' | 'delete' | 'rename';
  path: string;
  previousContent: string | null;
  renamedTo?: string;
}

export interface SessionSnapshot {
  projectRoot: string;
  stack: 'expo' | 'expo-convex' | 'expo-supabase';
  createdAt: number;
  turns: number;
  journal: FileJournalEntry[];
  messages: any[];
  initialPrompt: string;
  confirmedEnvVars: string[];
  blueprint?: Blueprint;
}

export class Session {
  readonly projectRoot: string;
  readonly stack: 'expo' | 'expo-convex' | 'expo-supabase';
  readonly initialPrompt: string;
  readonly context: ContextManager;
  readonly installManager: InstallManager;

  private nextStepId = 1;
  private journal: FileJournalEntry[] = [];
  private turnCount = 0;
  private authToken: string;
  private confirmedEnvVars = new Set<string>();
  private interruptRequested = false;
  private onJournalListeners = new Set<(entry: FileJournalEntry) => void>();

  /** Architect's blueprint — set after the initial build pipeline runs. */
  private blueprint: Blueprint | null = null;

  constructor(opts: {
    projectRoot: string;
    stack: 'expo' | 'expo-convex' | 'expo-supabase';
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

  // ── Blueprint ──────────────────────────────────────────────────────────

  setBlueprint(bp: Blueprint): void {
    this.blueprint = bp;
  }

  getBlueprint(): Blueprint | null {
    return this.blueprint;
  }

  /** True if the initial multi-agent build pipeline has already run. */
  hasBuilt(): boolean {
    return this.blueprint !== null;
  }

  // ── File journal ───────────────────────────────────────────────────────

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

  getRecentOperations(n = 10): FileJournalEntry[] {
    return this.journal.slice(-n);
  }

  undoLastOperation(): FileJournalEntry | null {
    const entry = this.journal.pop();
    if (!entry) return null;

    const absPath = path.resolve(this.projectRoot, entry.path);

    switch (entry.kind) {
      case 'create':
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        break;
      case 'update':
        if (entry.previousContent !== null) {
          fs.writeFileSync(absPath, entry.previousContent, 'utf-8');
        }
        break;
      case 'delete':
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
      blueprint: this.blueprint ?? undefined,
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

  restoreFrom(snapshot: SessionSnapshot): void {
    this.turnCount = snapshot.turns;
    this.journal = snapshot.journal;
    this.nextStepId = Math.max(0, ...this.journal.map((e) => e.id)) + 1;
    for (const name of snapshot.confirmedEnvVars) {
      this.confirmedEnvVars.add(name);
    }
    if (snapshot.blueprint) {
      this.blueprint = snapshot.blueprint;
    }
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
            this.context.addToolResults(msg.content);
          }
        }
      }
    }
  }
}
