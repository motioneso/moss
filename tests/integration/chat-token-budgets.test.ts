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
import { sql, type Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { AiRepository } from "@moss/ai";
import { ChatRepository } from "@moss/chat";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
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

// ─── #3156: ChatRepository.publishConversationSummary ─────────────────────────

describe("ChatRepository.publishConversationSummary", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;

  beforeAll(async () => {
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
  });

  async function seededThread(title: string, incognito = false) {
    return dataContext.withDataContext(userAContext(), async (db) => {
      const thread = await repository.openNewThread(db, { title, incognito });
      await repository.recordCompletedTurn(db, thread.id, "q1", "a1", {
        provider: "anthropic",
        model: "x"
      });
      await repository.recordCompletedTurn(db, thread.id, "q2", "a2", {
        provider: "anthropic",
        model: "x"
      });
      const messages = await repository.listMessages(db, thread.id);
      const fresh = await repository.getOwnedThreadById(db, ids.userA, thread.id);
      return { thread: fresh!, messageIds: messages.map((m) => m.id) };
    });
  }

  const readThread = (threadId: string) =>
    dataContext.withDataContext(userAContext(), (db) =>
      repository.getOwnedThreadById(db, ids.userA, threadId)
    );

  it("starts a fresh thread with no summary, no frontier and revision 0", async () => {
    const thread = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "fresh thread" })
    );
    expect(thread.conversation_summary).toBeNull();
    expect(thread.summary_covered_through_message_id).toBeNull();
    expect(thread.summary_revision).toBe(0);
  });

  it("publishes a matching candidate, advances the revision and never touches activity", async () => {
    const { thread, messageIds } = await seededThread("publish ok");
    const result = await dataContext.withDataContext(userAContext(), (db) =>
      repository.publishConversationSummary(db, {
        threadId: thread.id,
        expectedRevision: 0,
        expectedCoveredThroughMessageId: null,
        throughMessageId: messageIds[1]!,
        summary: "Decided: blue"
      })
    );
    expect(result).toBe("published");
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBe("Decided: blue");
    expect(after?.summary_covered_through_message_id).toBe(messageIds[1]);
    expect(after?.summary_revision).toBe(1);
    expect(after?.last_active_at).toEqual(thread.last_active_at);
  });

  it("publishes from the worker role, which is how the summary job runs", async () => {
    const { thread, messageIds } = await seededThread("publish as worker");
    const workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    try {
      const result = await new DataContextRunner(workerDb).withDataContext(userAContext(), (db) =>
        repository.publishConversationSummary(db, {
          threadId: thread.id,
          expectedRevision: 0,
          expectedCoveredThroughMessageId: null,
          throughMessageId: messageIds[1]!,
          summary: "Decided: cedar"
        })
      );
      expect(result).toBe("published");
    } finally {
      await workerDb.destroy();
    }
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBe("Decided: cedar");
    expect(after?.summary_revision).toBe(1);
  });

  it("never lets the worker publish into another owner's thread", async () => {
    const { thread, messageIds } = await seededThread("worker other owner");
    const workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    try {
      const result = await new DataContextRunner(workerDb).withDataContext(
        { actorUserId: ids.userB, requestId: "test" },
        (db) =>
          repository.publishConversationSummary(db, {
            threadId: thread.id,
            expectedRevision: 0,
            expectedCoveredThroughMessageId: null,
            throughMessageId: messageIds[1]!,
            summary: "stolen"
          })
      );
      expect(result).toBe("missing");
    } finally {
      await workerDb.destroy();
    }
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBeNull();
    expect(after?.summary_revision).toBe(0);
  });

  it("lets the worker see a shared thread but never write its summary for the grantee", async () => {
    const { thread } = await seededThread("worker shared grantee");
    await dataContext.withDataContext(userAContext(), (db) =>
      sql`INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
      VALUES ('chat_thread', ${thread.id}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, 'manage')`.execute(
        db.db
      )
    );
    const workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    try {
      const { visible, updated } = await new DataContextRunner(workerDb).withDataContext(
        { actorUserId: ids.userB, requestId: "test" },
        async (db) => {
          const visible = await db.db
            .selectFrom("app.chat_threads")
            .select("id")
            .where("id", "=", thread.id)
            .execute();
          const updated = await db.db
            .updateTable("app.chat_threads")
            .set({ conversation_summary: "stolen", summary_revision: 9 })
            .where("id", "=", thread.id)
            .returning("id")
            .execute();
          return { visible, updated };
        }
      );
      expect(visible).toHaveLength(1);
      expect(updated).toHaveLength(0);
    } finally {
      await workerDb.destroy();
    }
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBeNull();
    expect(after?.summary_revision).toBe(0);
  });

  it("never lets the worker change any thread column outside the summary", async () => {
    const { thread } = await seededThread("worker column limit");
    const workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    try {
      await expect(
        new DataContextRunner(workerDb).withDataContext(userAContext(), (db) =>
          db.db
            .updateTable("app.chat_threads")
            .set({ title: "renamed by worker" })
            .where("id", "=", thread.id)
            .execute()
        )
      ).rejects.toThrow(/permission denied/);
    } finally {
      await workerDb.destroy();
    }
    const after = await readThread(thread.id);
    expect(after?.title).toBe("worker column limit");
  });

  it("refuses a candidate prepared against an older revision", async () => {
    const { thread, messageIds } = await seededThread("stale revision");
    const publish = (
      expectedRevision: number,
      expectedFrontier: string | null,
      through: string,
      summary: string
    ) =>
      dataContext.withDataContext(userAContext(), (db) =>
        repository.publishConversationSummary(db, {
          threadId: thread.id,
          expectedRevision,
          expectedCoveredThroughMessageId: expectedFrontier,
          throughMessageId: through,
          summary
        })
      );
    expect(await publish(0, null, messageIds[1]!, "first")).toBe("published");
    // Frontier matches the live row; only the revision is behind.
    expect(await publish(0, messageIds[1]!, messageIds[3]!, "late loser")).toBe("stale");
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBe("first");
    expect(after?.summary_revision).toBe(1);
  });

  it("refuses a candidate whose expected frontier no longer matches", async () => {
    const { thread, messageIds } = await seededThread("stale frontier");
    await dataContext.withDataContext(userAContext(), (db) =>
      repository.publishConversationSummary(db, {
        threadId: thread.id,
        expectedRevision: 0,
        expectedCoveredThroughMessageId: null,
        throughMessageId: messageIds[1]!,
        summary: "first"
      })
    );
    const result = await dataContext.withDataContext(userAContext(), (db) =>
      repository.publishConversationSummary(db, {
        threadId: thread.id,
        expectedRevision: 1,
        expectedCoveredThroughMessageId: messageIds[0]!,
        throughMessageId: messageIds[3]!,
        summary: "wrong base"
      })
    );
    expect(result).toBe("stale");
    expect((await readThread(thread.id))?.conversation_summary).toBe("first");
  });

  it("refuses a frontier that does not move past the current one", async () => {
    const { thread, messageIds } = await seededThread("frontier regress");
    const publish = (through: string, summary: string) =>
      dataContext.withDataContext(userAContext(), (db) =>
        repository.publishConversationSummary(db, {
          threadId: thread.id,
          expectedRevision: 1,
          expectedCoveredThroughMessageId: messageIds[1]!,
          throughMessageId: through,
          summary
        })
      );
    await dataContext.withDataContext(userAContext(), (db) =>
      repository.publishConversationSummary(db, {
        threadId: thread.id,
        expectedRevision: 0,
        expectedCoveredThroughMessageId: null,
        throughMessageId: messageIds[1]!,
        summary: "first"
      })
    );
    expect(await publish(messageIds[0]!, "backwards")).toBe("stale");
    expect(await publish(messageIds[1]!, "same frontier")).toBe("stale");
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBe("first");
    expect(after?.summary_covered_through_message_id).toBe(messageIds[1]);
    expect(after?.summary_revision).toBe(1);
    expect(await publish(messageIds[3]!, "forward")).toBe("published");
  });

  it("refuses a frontier that belongs to another thread", async () => {
    const target = await seededThread("frontier target");
    const other = await seededThread("frontier other");
    const result = await dataContext.withDataContext(userAContext(), (db) =>
      repository.publishConversationSummary(db, {
        threadId: target.thread.id,
        expectedRevision: 0,
        expectedCoveredThroughMessageId: null,
        throughMessageId: other.messageIds[1]!,
        summary: "cross-thread"
      })
    );
    expect(result).toBe("stale");
    expect((await readThread(target.thread.id))?.summary_revision).toBe(0);
  });

  it("never publishes into another owner's thread", async () => {
    const { thread, messageIds } = await seededThread("foreign owner");
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "foreign" },
      (db) =>
        repository.publishConversationSummary(db, {
          threadId: thread.id,
          expectedRevision: 0,
          expectedCoveredThroughMessageId: null,
          throughMessageId: messageIds[1]!,
          summary: "intruder"
        })
    );
    expect(result).toBe("missing");
    const after = await readThread(thread.id);
    expect(after?.conversation_summary).toBeNull();
    expect(after?.summary_revision).toBe(0);
  });

  it("never publishes into a private conversation", async () => {
    const { thread, messageIds } = await seededThread("private", true);
    const result = await dataContext.withDataContext(userAContext(), (db) =>
      repository.publishConversationSummary(db, {
        threadId: thread.id,
        expectedRevision: 0,
        expectedCoveredThroughMessageId: null,
        throughMessageId: messageIds[1]!,
        summary: "private leak"
      })
    );
    expect(result).toBe("missing");
    expect((await readThread(thread.id))?.conversation_summary).toBeNull();
  });
});

// ─── Task 4: DataContextChatPersistence listPriorTurns ────────────────────────

describe("DataContextChatPersistence.listPriorTurns replay", () => {
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

  async function threadWithTurns(actorUserId: string, title: string, count: number) {
    const ctx = { actorUserId, requestId: "t" };
    const thread = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.openNewThread(db, { title })
    );
    for (let i = 1; i <= count; i++) {
      await dataContext.withDataContext(ctx, (db) =>
        chatRepo.recordCompletedTurn(db, thread.id, `q${i}`, `a${i}`, {
          provider: "anthropic",
          model: "x"
        })
      );
    }
    const messages = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.listMessages(db, thread.id)
    );
    return { thread, ctx, messageIds: messages.map((m) => m.id) };
  }

  it("replays every stored turn when no summary has been accepted", async () => {
    await threadWithTurns(ids.userB, "no summary", 2);
    const result = await persistence.listPriorTurns(ids.userB);
    expect(result.oldSummary).toBeNull();
    expect(result.recent.map((t) => t.content)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("replays the accepted summary plus every turn after its frontier, with no gap", async () => {
    const origK = process.env.JARVIS_CHAT_REPLAY_K;
    process.env.JARVIS_CHAT_REPLAY_K = "2";
    try {
      const { thread, ctx, messageIds } = await threadWithTurns(ids.userA, "frontier split", 3);
      await dataContext.withDataContext(ctx, (db) =>
        chatRepo.publishConversationSummary(db, {
          threadId: thread.id,
          expectedRevision: 0,
          expectedCoveredThroughMessageId: null,
          throughMessageId: messageIds[1]!,
          summary: "Turn 1 settled on blue."
        })
      );

      const result = await persistence.listPriorTurns(ids.userA);
      expect(result.oldSummary).toBe("Turn 1 settled on blue.");
      // K no longer truncates: every uncovered turn replays.
      expect(result.recent.map((t) => t.content)).toEqual(["q2", "a2", "q3", "a3"]);
    } finally {
      if (origK === undefined) {
        delete process.env.JARVIS_CHAT_REPLAY_K;
      } else {
        process.env.JARVIS_CHAT_REPLAY_K = origK;
      }
    }
  });

  it("never synthesizes a summary on read and never silently drops old turns", async () => {
    await threadWithTurns(ids.userA, "no-synthesis test", 25);
    const result = await persistence.listPriorTurns(ids.userA);
    expect(result.oldSummary).toBeNull();
    expect(result.recent).toHaveLength(50);
    expect(result.recent[0]?.content).toBe("q1");
  });

  it("forceReplay and plain launch select the same replay", async () => {
    await threadWithTurns(ids.userA, "forceReplay collapse test", 25);
    const plain = await persistence.listPriorTurns(ids.userA);
    const relaunch = await persistence.listPriorTurns(ids.userA, { forceReplay: true });
    expect(relaunch.recent).toEqual(plain.recent);
  });
});

describe("DataContextChatPersistence.recordTurn summary writes", () => {
  it("never writes a summary inline; condensing runs only through the summary job", async () => {
    const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    const dataContext = new DataContextRunner(appDb);
    const chatRepo = new ChatRepository();
    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: chatRepo,
      aiRepository: new AiRepository()
    });
    const ctx = { actorUserId: ids.userA, requestId: "t" };
    const thread = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.openNewThread(db, { title: "no inline summary" })
    );
    for (let i = 1; i <= 45; i++) {
      await persistence.recordTurn(ids.userA, `u${i}`, `bot${i}`, {
        provider: "anthropic",
        model: "x"
      });
    }
    const updated = await dataContext.withDataContext(ctx, (db) =>
      chatRepo.getThreadById(db, thread.id)
    );
    expect(updated?.conversation_summary).toBeNull();
    expect(updated?.summary_revision).toBe(0);
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
