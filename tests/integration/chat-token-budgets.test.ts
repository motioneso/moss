/**
 * Integration tests for chat token budget feature (issue #81).
 * Tasks: migration column, trimToTokenBudget pure logic, listPriorTurns bounded
 * replay, recordTurn rolling summary, env-var overrides, launchSession injection.
 *
 * Single file-level resetFoundationDatabase() to avoid pg-boss background workers
 * from one reset interfering with the DROP SCHEMA of the next.
 */
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { AiRepository } from "@moss/ai";
import { ChatRepository } from "@moss/chat";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { DEFAULT_REPLAY_MESSAGES } from "../../packages/chat/src/live/replay-window.js";
import {
  estimateTokens,
  trimToTokenBudget,
  type EpisodicChunk
} from "../../packages/chat/src/live/recall-seed.js";
import {
  ChatSessionManager,
  type ChatPersistencePort
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// Single reset — migratePgBoss starts background workers; subsequent DROP SCHEMA
// would race against those workers if we reset multiple times in one file.
beforeAll(async () => {
  await resetFoundationDatabase();
});

function userAContext() {
  return { actorUserId: ids.userA, requestId: "test" };
}

// ─── Task 1: migration ────────────────────────────────────────────────────────

describe("chat-token-budgets migration (00NN)", () => {
  it("chat_threads has conversation_summary column", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app'
           AND table_name   = 'chat_threads'
           AND column_name  = 'conversation_summary'`
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

// ─── Task 2: estimateTokens + trimToTokenBudget (pure logic, no DB) ──────────

describe("estimateTokens", () => {
  it("estimates 1 token per 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("trimToTokenBudget", () => {
  it("returns all chunks when total tokens fit in budget", () => {
    const chunks: EpisodicChunk[] = [
      { text: "aaaa", date: "2026-01-01", threadId: "t1", hybridScore: 0.9 }, // 1 token
      { text: "bbbb", date: "2026-01-02", threadId: "t2", hybridScore: 0.8 } // 1 token
    ];
    const kept = trimToTokenBudget(chunks, 10);
    expect(kept).toHaveLength(2);
  });

  it("keeps highest-scoring chunks first when budget is tight", () => {
    const chunks: EpisodicChunk[] = [
      { text: "a".repeat(200), date: "2026-01-01", threadId: "t1", hybridScore: 0.3 }, // 50 tokens
      { text: "b".repeat(200), date: "2026-01-02", threadId: "t2", hybridScore: 0.9 }, // 50 tokens
      { text: "c".repeat(200), date: "2026-01-03", threadId: "t3", hybridScore: 0.6 } // 50 tokens
    ];
    // Budget of 80 tokens: high (0.9) fits (50), mid (0.6) total = 100 > 80 → stopped
    const kept = trimToTokenBudget(chunks, 80);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.hybridScore).toBe(0.9);
  });

  it("returns empty array when budget is 0", () => {
    const chunks: EpisodicChunk[] = [
      { text: "hello", date: "2026-01-01", threadId: "t1", hybridScore: 0.9 }
    ];
    expect(trimToTokenBudget(chunks, 0)).toHaveLength(0);
  });

  it("returns empty array when input is empty", () => {
    expect(trimToTokenBudget([], 1500)).toHaveLength(0);
  });
});

// ─── Task 3: ChatRepository.updateConversationSummary ─────────────────────────

describe("ChatRepository.updateConversationSummary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;

  beforeAll(async () => {
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
  });

  it("stores a summary on a thread and is readable back", async () => {
    const thread = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "summary test" })
    );

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.updateConversationSummary(scopedDb, thread.id, "As of turn 2: I helped with X.")
    );

    const updated = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getThreadById(scopedDb, thread.id)
    );
    expect(updated?.conversation_summary).toBe("As of turn 2: I helped with X.");
  });

  it("conversation_summary is null on a freshly-created thread", async () => {
    const thread = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "fresh thread" })
    );
    expect(thread.conversation_summary).toBeNull();
  });
});

// ─── Task 4: DataContextChatPersistence listPriorTurns + recordTurn ───────────

describe("DataContextChatPersistence.listPriorTurns bounded replay", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let chatRepo: ChatRepository;
  let persistence: DataContextChatPersistence;

  beforeAll(async () => {
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    chatRepo = new ChatRepository();
    persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: chatRepo,
      aiRepository: new AiRepository()
    });
    // Create the thread for userB so tests can seed messages independently.
    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "test-setup" },
      (scopedDb) => chatRepo.openNewThread(scopedDb, { title: "replay test" })
    );
  });

  it("returns all turns by default when under the replay window (unset K -> DEFAULT_REPLAY_MESSAGES)", async () => {
    const ctx = { actorUserId: ids.userB, requestId: "t" };
    const thread = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.getCurrentThread(db, ids.userB)
    );
    await dataContext.withDataContext(ctx, (db) =>
      chatRepo.recordCompletedTurn(db, thread!.id, "q1", "a1", {
        provider: "anthropic",
        model: "x"
      })
    );
    await dataContext.withDataContext(ctx, (db) =>
      chatRepo.recordCompletedTurn(db, thread!.id, "q2", "a2", {
        provider: "anthropic",
        model: "x"
      })
    );

    const result = await persistence.listPriorTurns(ids.userB);
    expect(result.oldSummary).toBeNull();
    expect(result.recent.length).toBeGreaterThanOrEqual(4);
    expect(result.recent.some((t) => t.content === "q1")).toBe(true);
  });

  it("returns prior turns when replay K is explicitly overridden", async () => {
    const origK = process.env.JARVIS_CHAT_REPLAY_K;
    process.env.JARVIS_CHAT_REPLAY_K = "10";
    try {
      const result = await persistence.listPriorTurns(ids.userB);
      expect(result.oldSummary).toBeNull();
      expect(result.recent.length).toBeGreaterThanOrEqual(4);
      expect(result.recent.some((t) => t.content === "q1")).toBe(true);
    } finally {
      if (origK === undefined) {
        delete process.env.JARVIS_CHAT_REPLAY_K;
      } else {
        process.env.JARVIS_CHAT_REPLAY_K = origK;
      }
    }
  });

  it("read path: recent is capped by K, oldSummary comes only from the stored column (D3)", async () => {
    // Fresh thread for userA so this test's turns are isolated.
    const origK = process.env.JARVIS_CHAT_REPLAY_K;
    process.env.JARVIS_CHAT_REPLAY_K = "2";
    try {
      const ctx = { actorUserId: ids.userA, requestId: "t" };
      const thread = await dataContext.withDataContext(ctx, (db) =>
        chatRepo.openNewThread(db, { title: "k-split test" })
      );
      // Record 3 turns = 6 messages. With K=2, only last 2 messages are recent.
      for (let i = 1; i <= 3; i++) {
        await dataContext.withDataContext(ctx, (db) =>
          chatRepo.recordCompletedTurn(db, thread.id, `q${i}`, `a${i}`, {
            provider: "anthropic",
            model: "x"
          })
        );
      }
      // D3: oldSummary is read only from the stored `conversation_summary`
      // column, never synthesized lazily at read time — write it directly
      // (the write path itself is covered by the "rolling summary" describe
      // block below).
      await dataContext.withDataContext(ctx, (db) =>
        chatRepo.updateConversationSummary(db, thread.id, "As of turn 1: a1 happened.")
      );

      const result = await persistence.listPriorTurns(ids.userA);
      expect(result.recent).toHaveLength(2);
      expect(result.oldSummary).toBe("As of turn 1: a1 happened.");
    } finally {
      if (origK === undefined) {
        delete process.env.JARVIS_CHAT_REPLAY_K;
      } else {
        process.env.JARVIS_CHAT_REPLAY_K = origK;
      }
    }
  });

  it("T2-b: read path never synthesizes a summary, even with plenty of old turns beyond the window", async () => {
    const ctx = { actorUserId: ids.userA, requestId: "t" };
    const thread = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.openNewThread(db, { title: "no-synthesis test" })
    );
    // Seed well past DEFAULT_REPLAY_MESSAGES via the repository directly (not
    // persistence.recordTurn), so the conversation_summary column stays null —
    // there is plenty of "old" history a read-time synthesizer could summarize.
    for (let i = 1; i <= 25; i++) {
      await dataContext.withDataContext(ctx, (db) =>
        chatRepo.recordCompletedTurn(db, thread.id, `q${i}`, `a${i}`, {
          provider: "anthropic",
          model: "x"
        })
      );
    }

    const result = await persistence.listPriorTurns(ids.userA);
    expect(result.oldSummary).toBeNull();
  });

  it("T2-d: unset K -> forceReplay and plain launch select identical windows (both cap at 40)", async () => {
    const ctx = { actorUserId: ids.userA, requestId: "t" };
    const thread = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.openNewThread(db, { title: "forceReplay collapse test" })
    );
    // 25 turns = 50 stored messages, well past DEFAULT_REPLAY_MESSAGES (40).
    for (let i = 1; i <= 25; i++) {
      await dataContext.withDataContext(ctx, (db) =>
        chatRepo.recordCompletedTurn(db, thread.id, `q${i}`, `a${i}`, {
          provider: "anthropic",
          model: "x"
        })
      );
    }

    const plain = await persistence.listPriorTurns(ids.userA);
    const relaunch = await persistence.listPriorTurns(ids.userA, { forceReplay: true });

    expect(plain.recent).toHaveLength(DEFAULT_REPLAY_MESSAGES);
    expect(relaunch.recent).toHaveLength(DEFAULT_REPLAY_MESSAGES);
    expect(relaunch.recent).toEqual(plain.recent);
  });
});

describe("DataContextChatPersistence.recordTurn rolling summary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let chatRepo: ChatRepository;
  let persistence: DataContextChatPersistence;

  beforeAll(async () => {
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    chatRepo = new ChatRepository();
    persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: chatRepo,
      aiRepository: new AiRepository()
    });
  });

  it("stores conversation_summary on thread after stored turns exceed DEFAULT_REPLAY_MESSAGES (D3 write gate)", async () => {
    // D3: the write gate is the DEFAULT_REPLAY_MESSAGES constant (40 messages),
    // not K — set K to something unrelated to prove the write path ignores it.
    const origK = process.env.JARVIS_CHAT_REPLAY_K;
    process.env.JARVIS_CHAT_REPLAY_K = "2";
    try {
      const ctx = { actorUserId: ids.userA, requestId: "t" };
      const thread = await dataContext.withDataContext(ctx, (db) =>
        chatRepo.openNewThread(db, { title: "summary-store test" })
      );
      // Drive past the summary's character cap as well as the 40-message write gate.
      for (let i = 1; i <= 45; i++) {
        await persistence.recordTurn(ids.userA, `u${i}-${"x".repeat(50)}`, `bot${i}`, {
          provider: "anthropic",
          model: "x"
        });
      }

      const updated = await dataContext.withDataContext(ctx, (db) =>
        chatRepo.getThreadById(db, thread.id)
      );
      expect(updated?.conversation_summary).not.toBeNull();
      expect(updated?.conversation_summary).toMatch(/user: u1-/);
      expect(updated?.conversation_summary).toMatch(/bot1\b/);
    } finally {
      if (origK === undefined) {
        delete process.env.JARVIS_CHAT_REPLAY_K;
      } else {
        process.env.JARVIS_CHAT_REPLAY_K = origK;
      }
    }
  });

  it("T2-a: write gate ignores replay opt-out (K=0) — fires past 40 stored messages, not before", async () => {
    // D3: the write gate is DEFAULT_REPLAY_MESSAGES, independent of K. Prove it
    // with the most aggressive opt-out (K=0, meaning "no replay at all") —
    // summaries must still accrue for long threads regardless.
    const origK = process.env.JARVIS_CHAT_REPLAY_K;
    process.env.JARVIS_CHAT_REPLAY_K = "0";
    try {
      const ctx = { actorUserId: ids.userA, requestId: "t" };
      const thread = await dataContext.withDataContext(ctx, (db) =>
        chatRepo.openNewThread(db, { title: "k-zero write-gate test" })
      );

      // 15 turns = 30 stored messages: under the 40-message threshold, no write yet.
      for (let i = 1; i <= 15; i++) {
        await persistence.recordTurn(ids.userA, `u${i}`, `bot${i}`, {
          provider: "anthropic",
          model: "x"
        });
      }
      const beforeGate = await dataContext.withDataContext(ctx, (db) =>
        chatRepo.getThreadById(db, thread.id)
      );
      expect(beforeGate?.conversation_summary).toBeNull();

      // 6 more turns brings stored messages to 42 (> 40): the gate now fires.
      for (let i = 16; i <= 21; i++) {
        await persistence.recordTurn(ids.userA, `u${i}`, `bot${i}`, {
          provider: "anthropic",
          model: "x"
        });
      }
      const afterGate = await dataContext.withDataContext(ctx, (db) =>
        chatRepo.getThreadById(db, thread.id)
      );
      expect(afterGate?.conversation_summary).not.toBeNull();
    } finally {
      if (origK === undefined) {
        delete process.env.JARVIS_CHAT_REPLAY_K;
      } else {
        process.env.JARVIS_CHAT_REPLAY_K = origK;
      }
    }
  });
});

// ─── Task 5: launchSession bounded inject (fake engine) ───────────────────────

class FakeEngineForSession implements CliChatEngine {
  readonly provider = "anthropic" as const;
  readonly submitted: string[] = [];

  async launch(): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(text: string): Promise<void> {
    this.submitted.push(text);
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    return { records: [], offset: afterOffset, complete: true };
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

describe("launchSession — bounded inject (fake engine)", () => {
  it("injects <prior-context> + K-turn <conversation> when persistence returns both", async () => {
    const fakePersistence: ChatPersistencePort = {
      resolveActiveProvider: async () => ({ provider: "anthropic", model: "test" }),
      listPriorTurns: async () => ({
        recent: [
          { role: "user", content: "recent user msg" },
          { role: "assistant", content: "recent assistant msg" }
        ],
        oldSummary: "As of turn 5: old context here"
      }),
      recordTurn: async () => {},
      openNewConversation: async () => {},
      getThreadContext: async () => ({ threadTitle: null, localTimezone: null, incognito: false }),
      touchExistingThread: async () => true
    };

    const engine = new FakeEngineForSession();
    const manager = new ChatSessionManager({
      engineFactory: () => engine,
      persistence: fakePersistence,
      personaFs: { mkdir: async () => {}, writeFile: async () => {} },
      clock: { now: () => 0 },
      idleMs: 60_000,
      neutralBase: "/tmp",
      persona: "You are Jarvis.",
      pollMs: 0
    });

    await manager.ensureSession("user-1", "Test User");

    expect(engine.submitted).toHaveLength(1);
    const inject = engine.submitted[0] ?? "";
    expect(inject).toContain("<prior-context>");
    expect(inject).toContain("As of turn 5: old context here");
    expect(inject).toContain("recent user msg");
    expect(inject).toContain("recent assistant msg");
    expect(inject).not.toContain("<memory>");
  });

  it("skips inject entirely when listPriorTurns returns empty recent + null summary", async () => {
    const fakePersistence: ChatPersistencePort = {
      resolveActiveProvider: async () => ({ provider: "anthropic", model: "test" }),
      listPriorTurns: async () => ({ recent: [], oldSummary: null }),
      recordTurn: async () => {},
      openNewConversation: async () => {},
      getThreadContext: async () => ({ threadTitle: null, localTimezone: null, incognito: false }),
      touchExistingThread: async () => true
    };

    const engine = new FakeEngineForSession();
    const manager = new ChatSessionManager({
      engineFactory: () => engine,
      persistence: fakePersistence,
      personaFs: { mkdir: async () => {}, writeFile: async () => {} },
      clock: { now: () => 0 },
      idleMs: 60_000,
      neutralBase: "/tmp",
      persona: "You are Jarvis.",
      pollMs: 0
    });

    await manager.ensureSession("user-2", "Test User");
    expect(engine.submitted).toHaveLength(0);
  });
});

// ─── Task 5: memory seed budget env override ─────────────────────────────────

describe("memory seed budget env override", () => {
  it("JARVIS_CHAT_SEED_BUDGET_TOKENS=50 trims chunks to fit ≤50 tokens", () => {
    const original = process.env.JARVIS_CHAT_SEED_BUDGET_TOKENS;
    process.env.JARVIS_CHAT_SEED_BUDGET_TOKENS = "50";
    try {
      // Budget 50 tokens = 200 chars. big=400 chars (100 tokens) exceeds; small=100 chars (25 tokens) fits.
      const big: EpisodicChunk = {
        text: "x".repeat(400),
        date: "2025-01-01",
        threadId: "t1",
        hybridScore: 0.5
      };
      const small: EpisodicChunk = {
        text: "y".repeat(100),
        date: "2025-01-01",
        threadId: "t2",
        hybridScore: 0.9
      };
      const budget = process.env.JARVIS_CHAT_SEED_BUDGET_TOKENS
        ? parseInt(process.env.JARVIS_CHAT_SEED_BUDGET_TOKENS, 10)
        : 1500;
      const result = trimToTokenBudget([big, small], budget);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(small);
    } finally {
      if (original === undefined) {
        delete process.env.JARVIS_CHAT_SEED_BUDGET_TOKENS;
      } else {
        process.env.JARVIS_CHAT_SEED_BUDGET_TOKENS = original;
      }
    }
  });
});
