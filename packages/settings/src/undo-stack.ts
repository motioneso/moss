export interface SettingsUndoEntry {
  readonly mutationId: string;
  readonly key: string;
  readonly previousValue: unknown;
  // Pre-mutation revision only — null means the row did not exist before the tracked write.
  // Used ONLY to pick the undo's delete-vs-upsert branch; never as a CAS expectation (that's
  // resultingRevision below). Do not conflate the two — resultingRevision is always non-null.
  readonly previousRevision: number | null;
  // Revision produced BY the tracked write (its own return value, never a follow-up read). This
  // is what the DB's current revision must still equal for undo's CAS write to succeed — expecting
  // previousRevision instead guarantees a conflict on the very next turn, since the tracked write
  // itself already advanced the row past it.
  readonly resultingRevision: number;
  readonly appliedAt: number;
}

const MAX_ENTRIES_PER_CHAT = 20;
const MAX_TRACKED_CHATS = 500;
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;

interface ChatUndoStack {
  entries: SettingsUndoEntry[];
}

export interface SettingsUndoStackOptions {
  readonly maxEntriesPerChat?: number;
  readonly maxTrackedChats?: number;
  readonly maxEntryAgeMs?: number;
}

// Nested actorUserId -> chatId maps avoid the `${actorUserId}:${chatId}` string-concat collision
// (chat-surface-pattern-trap in agentmemory), and the LRU map bounds total retained undo data —
// private previousValue payloads (e.g. a home address) must not live forever per (actor, chat).
export class SettingsUndoStack {
  private readonly actors = new Map<string, Map<string, ChatUndoStack>>();
  private readonly lru = new Map<ChatUndoStack, { actorUserId: string; chatId: string }>();
  private readonly maxEntriesPerChat: number;
  private readonly maxTrackedChats: number;
  private readonly maxEntryAgeMs: number;

  constructor(options: SettingsUndoStackOptions = {}) {
    this.maxEntriesPerChat = options.maxEntriesPerChat ?? MAX_ENTRIES_PER_CHAT;
    this.maxTrackedChats = options.maxTrackedChats ?? MAX_TRACKED_CHATS;
    this.maxEntryAgeMs = options.maxEntryAgeMs ?? MAX_ENTRY_AGE_MS;
  }

  private touch(actorUserId: string, chatId: string): ChatUndoStack {
    let chats = this.actors.get(actorUserId);
    if (!chats) {
      chats = new Map();
      this.actors.set(actorUserId, chats);
    }
    let stack = chats.get(chatId);
    if (!stack) {
      stack = { entries: [] };
      chats.set(chatId, stack);
    }
    this.lru.delete(stack);
    this.lru.set(stack, { actorUserId, chatId });
    this.evictLeastRecentlyUsed();
    return stack;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.lru.size > this.maxTrackedChats) {
      const oldest = this.lru.keys().next();
      if (oldest.done) break;
      const ref = this.lru.get(oldest.value);
      this.lru.delete(oldest.value);
      if (!ref) continue;
      const chats = this.actors.get(ref.actorUserId);
      chats?.delete(ref.chatId);
      if (chats && chats.size === 0) this.actors.delete(ref.actorUserId);
    }
  }

  private sweepExpired(stack: ChatUndoStack): void {
    if (this.maxEntryAgeMs <= 0) return;
    const now = Date.now();
    for (;;) {
      const oldest = stack.entries[0];
      if (!oldest || now - oldest.appliedAt <= this.maxEntryAgeMs) break;
      stack.entries.shift();
    }
  }

  push(actorUserId: string, chatId: string, entry: SettingsUndoEntry): void {
    const stack = this.touch(actorUserId, chatId);
    this.sweepExpired(stack);
    stack.entries.push(entry);
    if (stack.entries.length > this.maxEntriesPerChat) stack.entries.shift();
  }

  peek(actorUserId: string, chatId: string): SettingsUndoEntry | undefined {
    const stack = this.actors.get(actorUserId)?.get(chatId);
    if (!stack) return undefined;
    this.sweepExpired(stack);
    return stack.entries.at(-1);
  }

  pop(actorUserId: string, chatId: string): SettingsUndoEntry | undefined {
    const stack = this.actors.get(actorUserId)?.get(chatId);
    if (!stack) return undefined;
    this.sweepExpired(stack);
    return stack.entries.pop();
  }

  clear(actorUserId: string, chatId: string): void {
    const chats = this.actors.get(actorUserId);
    const stack = chats?.get(chatId);
    if (stack) this.lru.delete(stack);
    chats?.delete(chatId);
    if (chats && chats.size === 0) this.actors.delete(actorUserId);
  }
}

// Package-level singleton — no persistence, cleared on process restart by design. Tool execute
// functions import this directly (same pattern as each file's own `new PreferencesRepository()`);
// no ToolServices/composition-host threading needed since it holds no cross-module state.
export const settingsUndoStack = new SettingsUndoStack();
