// src/agent/contextManager.ts
//
// Sliding-window context compaction for the agent loop.
//
// Problem this solves:
//   Without compaction, every tool result (file contents, directory listings,
//   search output) and every createFile tool_use block (full file content)
//   accumulates in `messages` and gets re-sent on every round. A 30-round
//   generation re-pays for round-1 tool results 29 times.
//
// Strategy:
//   - Keep the last N rounds of messages fully intact (agent needs recent context)
//   - Truncate tool_result content older than N rounds to short stubs
//   - Replace createFile tool_use inputs older than N rounds with file path only
//   - Deduplicate viewFile calls on the same path within a window
//
// What we DON'T touch:
//   - Initial user bootstrap message (index 0)
//   - Assistant text blocks (agent's reasoning/plans — usually small and useful)
//   - editFile tool_use (already small — just oldText/newText diffs)
//   - Recent messages within the keep-window

// ─── Types ───────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: MessageRole;
  /** String for simple user messages, array of blocks for assistant/tool turns */
  content: string | ContentBlock[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface ContextManagerConfig {
  /** Keep this many most-recent rounds (assistant + tool_result pairs) fully intact */
  keepRecentRounds: number;
  /** Tool results longer than this (chars) get truncated when they age out */
  toolResultMaxChars: number;
  /** createFile content longer than this gets stubbed when it ages out */
  createFileContentMaxChars: number;
  /** Dedupe viewFile on same path within this many rounds */
  viewDedupWindow: number;
}

const DEFAULT_CONFIG: ContextManagerConfig = {
  keepRecentRounds: 3,
  toolResultMaxChars: 400,
  createFileContentMaxChars: 200,
  viewDedupWindow: 4,
};

// ─── Context Manager ─────────────────────────────────────────────────────────

export class ContextManager {
  private messages: Message[] = [];
  private config: ContextManagerConfig;

  /** Track recent file reads to short-circuit redundant viewFile calls */
  private recentReads = new Map<string, number>(); // path → round number

  /** Track files that have been written so agent knows they exist post-compaction */
  private writtenFiles = new Set<string>();

  constructor(config: Partial<ContextManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Initial bootstrap ──────────────────────────────────────────────────

  setInitialMessage(text: string): void {
    this.messages = [{ role: 'user', content: text }];
  }

  // ── Adding turns ───────────────────────────────────────────────────────

  addAssistantMessage(blocks: ContentBlock[]): void {
    // Track which files have been created/written for dedup bookkeeping
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (block.name === 'createFile' && block.input.filePath) {
          this.writtenFiles.add(block.input.filePath);
          // A write counts as a "recent read" — the agent knows its own content
          this.recentReads.set(block.input.filePath, this.currentRound());
        }
        if (block.name === 'editFile' && block.input.filePath) {
          // Edit invalidates the dedup cache for that file — agent may need to re-check
          this.recentReads.delete(block.input.filePath);
        }
        if (block.name === 'viewFile' && block.input.filePath) {
          this.recentReads.set(block.input.filePath, this.currentRound());
        }
      }
    }
    this.messages.push({ role: 'assistant', content: blocks });
  }

  addToolResults(results: ToolResultBlock[]): void {
    this.messages.push({ role: 'user', content: results });
    this.compact();
  }

  // ── Compaction ─────────────────────────────────────────────────────────

  private compact(): void {
    // Preserve: index 0 (initial user message) + last 2*keepRecentRounds messages
    // (each round = 1 assistant + 1 tool_result user message = 2 messages)
    const keepFromEnd = this.config.keepRecentRounds * 2;
    const compactUntil = this.messages.length - keepFromEnd;

    // Start at 1 to skip initial user bootstrap
    for (let i = 1; i < compactUntil; i++) {
      const msg = this.messages[i];
      if (typeof msg.content === 'string') continue;

      msg.content = msg.content.map((block) => this.compactBlock(block));
    }
  }

  private compactBlock(block: ContentBlock): ContentBlock {
    // Truncate old tool results
    if (block.type === 'tool_result') {
      if (block.content.length > this.config.toolResultMaxChars) {
        return {
          ...block,
          content:
            `[Truncated — ${block.content.length} chars. ` +
            `Call the tool again if you need this data. ` +
            `Preview: ${block.content.slice(0, 150).replace(/\n/g, ' ')}...]`,
        };
      }
      return block;
    }

    // Strip createFile content (agent knows the file exists; doesn't need to see
    // the content it already wrote)
    if (block.type === 'tool_use' && block.name === 'createFile') {
      const content = block.input?.content;
      if (
        typeof content === 'string' &&
        content.length > this.config.createFileContentMaxChars
      ) {
        const lineCount = content.split('\n').length;
        return {
          ...block,
          input: {
            filePath: block.input.filePath,
            content: `[${lineCount}-line file written. Use editFile for changes.]`,
          },
        };
      }
    }

    // Strip readMultipleFiles / viewFile tool_use inputs are small — leave alone
    return block;
  }

  // ── Dedup helpers ──────────────────────────────────────────────────────

  /**
   * Call before executing a viewFile tool to decide if we should short-circuit.
   * Returns a stub string if the file was read/written very recently, else null.
   */
  getDedupStubForView(filePath: string): string | null {
    const lastRound = this.recentReads.get(filePath);
    if (lastRound === undefined) return null;

    const roundsAgo = this.currentRound() - lastRound;
    if (roundsAgo < this.config.viewDedupWindow) {
      if (this.writtenFiles.has(filePath)) {
        return (
          `[You wrote this file ${roundsAgo} round(s) ago. ` +
          `Content is unchanged unless you edited it. ` +
          `Use editFile directly if you know what to change.]`
        );
      }
      return (
        `[You viewed this file ${roundsAgo} round(s) ago. ` +
        `Content likely unchanged. Proceed with your planned edit, or if you genuinely ` +
        `need to re-inspect, continue — but prefer editFile.]`
      );
    }
    return null;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  getMessages(): Message[] {
    return this.messages;
  }

  /** Current round number = number of assistant turns so far */
  currentRound(): number {
    return this.messages.filter((m) => m.role === 'assistant').length;
  }

  /** Stats for logging/debugging */
  getStats() {
    const totalBlocks = this.messages.reduce((acc, m) => {
      return acc + (typeof m.content === 'string' ? 1 : m.content.length);
    }, 0);
    return {
      messageCount: this.messages.length,
      totalBlocks,
      filesWritten: this.writtenFiles.size,
      cachedReads: this.recentReads.size,
    };
  }

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text });
    this.compact();
  }
}
