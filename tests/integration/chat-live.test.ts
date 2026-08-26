import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql, type Kysely } from "kysely";

import {
  DataContextRunner,
  createDatabase,
  type AccessContext,
  type DataContextDb,
  type ChatMessage,
  type MossDatabase
} from "@moss/db";
import {
  ChatRepository,
  ChatUserMemorySettingsRepository,
  DataContextChatPersistence,
  PassiveContextRetriever,
  chatModuleManifest,
  handleExtractFactsJob
} from "@moss/chat";
import { AiRepository, createAiSecretCipher, type GenerateChatInput } from "@moss/ai";
import {
  GraphMemoryRecallService,
  MemoryCandidatesRepository,
  MemoryGraphRepository,
  StubEmbeddingProvider
} from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
const { Client } = pg;

describe("chat live runtime migration (0038)", () => {
  beforeAll(async () => {
    await resetFoundationDatabase();
  });
  it("0038: chat_threads has last_active_at", async () => {
    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const col = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='app' AND table_name='chat_threads' AND column_name='last_active_at'`
      );
      expect(col.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe("chat live runtime repository (recency + executed-model stamp)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;

  beforeAll(async () => {
    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
  });

  it("openNewThread creates a thread that getCurrentThread returns", async () => {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "First live thread" })
    );
    const current = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getCurrentThread(scopedDb, ids.userA)
    );

    expect(created.owner_user_id).toBe(ids.userA);
    expect(created.last_active_at).toBeTruthy();
    expect(current?.id).toBe(created.id);
  });

  it("a newer thread becomes the current one", async () => {
    const first = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Recency thread one" })
    );
    // Ensure a strictly later last_active_at for the second thread.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Recency thread two" })
    );

    const current = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getCurrentThread(scopedDb, ids.userA)
    );

    expect(first.id).not.toBe(second.id);
    expect(current?.id).toBe(second.id);
  });

  it("touchThread on an older thread makes it current again", async () => {
    const older = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Touch older" })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Touch newer" })
    );

    const beforeTouch = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getCurrentThread(scopedDb, ids.userA)
    );
    expect(beforeTouch?.id).toBe(newer.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const touched = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.touchThread(scopedDb, older.id)
    );

    const afterTouch = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getCurrentThread(scopedDb, ids.userA)
    );

    expect(touched?.id).toBe(older.id);
    expect(afterTouch?.id).toBe(older.id);
  });

  it("getCurrentThread returns undefined for an owner with no threads", async () => {
    const current = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getCurrentThread(scopedDb, ids.userB)
    );
    expect(current).toBeUndefined();
  });

  it("listThreads orders by last_active_at DESC — touchThread on older thread floats it to the top", async () => {
    // Create two threads; second is newer.
    const threadA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Ordering-A" })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const threadB = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Ordering-B" })
    );

    // B is newer → should be first in listThreads.
    const before = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listThreads(scopedDb)
    );
    const beforeIds = before.map((t) => t.id);
    expect(beforeIds.indexOf(threadB.id)).toBeLessThan(beforeIds.indexOf(threadA.id));

    // Touch A → A becomes most-recently-active → should float to top.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.touchThread(scopedDb, threadA.id)
    );

    const after = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listThreads(scopedDb)
    );
    const afterIds = after.map((t) => t.id);
    expect(afterIds.indexOf(threadA.id)).toBeLessThan(afterIds.indexOf(threadB.id));
  });
});

describe("passive context retrieval integration", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let graphRecall: GraphMemoryRecallService;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    graphRecall = new GraphMemoryRecallService(new StubEmbeddingProvider());
  });

  it("renders graph memory for a context-dependent turn and hides private ids", async () => {
    const write = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      graphRecall.remember(scopedDb, ids.userA, {
        predicate: "decided",
        objectText: "House project uses option A for cabinets",
        confidence: 0.94,
        provenance: "confirmed",
        importance: 0.9,
        source: {
          sourceKind: "chat",
          sourceRef: "chat:passive-private",
          sourceLabel: "Chat 2026-06-27",
          excerpt: "House project uses option A"
        }
      })
    );
    const retriever = new PassiveContextRetriever({ dataContext, graphRecall });

    const block = await retriever.retrieve({
      actorUserId: ids.userA,
      userText: "remember House project uses option A for cabinets",
      threadTitle: null,
      recentTurns: []
    });

    expect(block).toContain("<retrieved_context>");
    expect(block).toContain("House project uses option A");
    expect(block).not.toContain(write.fact.id);
    expect(block).not.toContain("chat:passive-private");
  });

  it("respects existing recall and facts settings", async () => {
    const settings = new ChatUserMemorySettingsRepository();
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      settings.update(scopedDb, ids.userA, { recallEnabled: false })
    );
    const retriever = new PassiveContextRetriever({ dataContext, graphRecall });

    const disabled = await retriever.retrieve({
      actorUserId: ids.userA,
      userText: "remember House project uses option A for cabinets",
      threadTitle: null,
      recentTurns: []
    });
    expect(disabled).toBe("");

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      settings.update(scopedDb, ids.userA, { recallEnabled: true, factsEnabled: false })
    );
    const factsDisabled = await retriever.retrieve({
      actorUserId: ids.userA,
      userText: "remember House project uses option A for cabinets",
      threadTitle: null,
      recentTurns: []
    });
    expect(factsDisabled).toBe("");
  });
});

describe("chat.listTodaysTurns read tool + listThreadsByActivity", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;

  beforeAll(async () => {
    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
  });

  it("listThreadsByActivity orders by last_active_at (active-today thread ahead of idle threads)", async () => {
    // An idle thread created/touched now, then an older thread re-activated AFTER it
    // via touchThread — the re-activated (older-created) thread must sort first.
    const idle = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Idle-by-activity" })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const activeToday = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.openNewThread(scopedDb, { title: "Active-today-by-activity" })
    );
    // Touch the idle one LAST so it has the most-recent last_active_at.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.touchThread(scopedDb, idle.id)
    );

    const threads = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listThreadsByActivity(scopedDb, 20)
    );
    const idleIndex = threads.findIndex((t) => t.id === idle.id);
    const activeIndex = threads.findIndex((t) => t.id === activeToday.id);
    expect(idleIndex).toBeGreaterThanOrEqual(0);
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    // idle was touched most recently, so it sorts before the earlier-touched thread.
    expect(idleIndex).toBeLessThan(activeIndex);
  });

  it("exposes chat.listTodaysTurns as a read tool excluding incognito threads", async () => {
    const tool = (chatModuleManifest.assistantTools ?? []).find(
      (t) => t.name === "chat.listTodaysTurns"
    );
    expect(tool?.risk).toBe("read");
    expect(tool?.permissionId).toBe("chat.view");

    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const normal = await repository.openNewThread(scopedDb, { title: "Today-tool-normal" });
      const secret = await repository.openNewThread(scopedDb, {
        title: "Today-tool-secret",
        incognito: true
      });
      await repository.recordCompletedTurn(scopedDb, normal.id, "hello today", "hi back", {
        provider: "anthropic",
        model: "claude-economy"
      });
      await repository.recordCompletedTurn(scopedDb, secret.id, "secret question", "secret reply", {
        provider: "anthropic",
        model: "claude-economy"
      });

      const result = await tool!.execute!(
        scopedDb,
        {},
        {
          actorUserId: ids.userA,
          requestId: "request:user-a-chat-live",
          chatSessionId: ""
        }
      );
      const turns = (result.data as { turns: Array<{ threadTitle: string; role: string }> }).turns;
      expect(turns.some((t) => t.threadTitle === "Today-tool-normal")).toBe(true);
      expect(turns.some((t) => t.threadTitle === "Today-tool-secret")).toBe(false);
      // both roles of the visible turn are present
      expect(turns.some((t) => t.threadTitle === "Today-tool-normal" && t.role === "user")).toBe(
        true
      );
      expect(
        turns.some((t) => t.threadTitle === "Today-tool-normal" && t.role === "assistant")
      ).toBe(true);
    });
  });
});

describe("handleExtractFactsJob — memory distillation candidates + no-op degrade", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let aiRepository: AiRepository;
  let candidatesRepository: MemoryCandidatesRepository;
  let graphRepository: MemoryGraphRepository;

  // A summarization/economy model + credentialed provider so the handler reaches the
  // (injected) adapter path instead of returning early on a missing model/credential.
  async function seedEconomyModel(label: string): Promise<void> {
    const provider = await dataContext.withDataContext(adminContext(), (scopedDb) =>
      aiRepository.createProvider(scopedDb, {
        providerKind: "anthropic",
        displayName: `Facts summarizer ${label}`,
        encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "facts-extract-key" })
      })
    );
    await dataContext.withDataContext(adminContext(), (scopedDb) =>
      aiRepository.createModel(scopedDb, {
        providerConfigId: provider.id,
        providerModelId: `facts-summarizer-${label}`,
        displayName: "Facts Summarizer",
        capabilities: ["summarization"],
        tier: "economy"
      })
    );
  }

  // Build ExtractFactsDeps with an injected fake adapter so no real HTTP call happens.
  function makeDeps(generate: (input: GenerateChatInput) => Promise<{ readonly text: string }>) {
    return {
      aiRepository,
      cipher: createAiSecretCipher(),
      candidatesRepository,
      graphRepository,
      createAdapter: () => ({ generateChat: generate })
    };
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1
    });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
    aiRepository = new AiRepository();
    candidatesRepository = new MemoryCandidatesRepository();
    graphRepository = new MemoryGraphRepository();
  });

  async function createTurn(
    scopedDb: DataContextDb,
    input: {
      readonly title: string;
      readonly user: string;
      readonly assistant?: string;
    }
  ): Promise<{
    readonly threadId: string;
    readonly userMessage: ChatMessage;
    readonly assistantMessage: ChatMessage;
  }> {
    const thread = await repository.openNewThread(scopedDb, { title: input.title });
    const result = await repository.recordCompletedTurn(
      scopedDb,
      thread.id,
      input.user,
      input.assistant ?? "Noted.",
      { provider: "anthropic", model: "claude-economy" }
    );
    if (!result) throw new Error("turn not recorded");
    return { threadId: thread.id, ...result };
  }

  it("skips social turns before model calls and writes no episode or candidate", async () => {
    let calls = 0;
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-skip",
        user: "hi",
        assistant: "hello"
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => {
          calls++;
          return { text: "[]" };
        })
      );

      expect(calls).toBe(0);
      expect(await candidatesRepository.listPending(scopedDb, ids.userA, 10)).toEqual([]);
    });
  });

  it("stores inferred candidates as pending and keeps them out of core recall", async () => {
    await seedEconomyModel("pending");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-pending",
        user: "My goal is to get serious about learning piano this summer."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "fact",
              action: "create",
              fact: { subject: "Ben", predicate: "has_goal", objectText: "learn piano" },
              provenance: "inferred",
              confidence: 0.99,
              importance: 0.8,
              sourceExcerpt: "I might be getting serious about learning piano",
              rationale: "Tentative user goal",
              isSensitive: false
            }
          ])
        }))
      );

      const pending = await candidatesRepository.listPending(scopedDb, ids.userA, 10);
      expect(pending).toContainEqual(
        expect.objectContaining({ kind: "fact", status: "pending", provenance: "inferred" })
      );
      const core = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(core.some((fact) => fact.objectText === "learn piano")).toBe(false);
    });
  });

  it("promotes explicit volunteered facts into graph memory", async () => {
    await seedEconomyModel("promote");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-promote",
        user: "Remember that I prefer brief launch updates."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "fact",
              action: "create",
              fact: { subject: "Ben", predicate: "prefers", objectText: "brief launch updates" },
              provenance: "volunteered",
              confidence: 0.8,
              importance: 0.9,
              sourceExcerpt: "Remember that I prefer brief launch updates.",
              rationale: "Explicit memory request",
              isSensitive: false
            }
          ])
        }))
      );

      const core = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(core).toContainEqual(
        expect.objectContaining({
          predicate: "prefers",
          objectText: "brief launch updates",
          provenance: "volunteered"
        })
      );
    });
  });

  it("uses exact queued message ids instead of latest thread messages", async () => {
    await seedEconomyModel("exact-messages");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await repository.openNewThread(scopedDb, { title: "Distill-exact" });
      const first = await repository.recordCompletedTurn(
        scopedDb,
        thread.id,
        "Remember that I prefer first turn context.",
        "Noted.",
        { provider: "anthropic", model: "claude-economy" }
      );
      await repository.recordCompletedTurn(
        scopedDb,
        thread.id,
        "Remember that I prefer second turn context.",
        "Noted.",
        { provider: "anthropic", model: "claude-economy" }
      );
      if (!first) throw new Error("first turn not recorded");

      let prompt = "";
      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: thread.id,
          userMessageId: first.userMessage.id,
          assistantMessageId: first.assistantMessage.id
        },
        makeDeps(async (input) => {
          prompt = input.messages[0]?.content ?? "";
          return { text: "[]" };
        })
      );

      expect(prompt).toContain("first turn context");
      expect(prompt).not.toContain("second turn context");
    });
  });

  it("scrubs secret-like thread titles from episode labels and extraction prompts", async () => {
    await seedEconomyModel("title-secret-filter");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const thread = await repository.openNewThread(scopedDb, {
        title: "sk-titleSecret1234567890"
      });
      const result = await repository.recordCompletedTurn(
        scopedDb,
        thread.id,
        "Remember that I prefer release notes on Fridays.",
        "Noted.",
        { provider: "anthropic", model: "claude-economy" }
      );
      if (!result) throw new Error("turn not recorded");

      let prompt = "";
      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: thread.id,
          userMessageId: result.userMessage.id,
          assistantMessageId: result.assistantMessage.id
        },
        makeDeps(async (input) => {
          prompt = input.messages[0]?.content ?? "";
          return { text: "[]" };
        })
      );

      const leakedLabels = await sql<{ count: string }>`
        SELECT count(*)::text AS count
        FROM app.memory_episodes
        WHERE owner_user_id = ${ids.userA}::uuid
          AND source_label ILIKE '%sk-titleSecret1234567890%'
      `.execute(scopedDb.db);

      expect(prompt).not.toContain("sk-titleSecret1234567890");
      expect(leakedLabels.rows[0]?.count).toBe("0");
    });
  });

  it("does not throw when generateChat throws", async () => {
    await seedEconomyModel("degrade-throw");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-degrade-throw",
        user: "Remember that provider failure should not block chat."
      });
      const deps = makeDeps(async () => {
        throw new Error("provider down");
      });
      await expect(
        handleExtractFactsJob(
          scopedDb,
          ids.userA,
          {
            actorUserId: ids.userA,
            threadId: turn.threadId,
            userMessageId: turn.userMessage.id,
            assistantMessageId: turn.assistantMessage.id
          },
          deps
        )
      ).resolves.toBeUndefined();
    });
  });

  it("grounded supersession supersedes only owner-scoped graph facts", async () => {
    await seedEconomyModel("graph-supersede");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const self = await graphRepository.ensureSelfEntity(scopedDb, ids.userA);
      const old = await graphRepository.createFact(scopedDb, ids.userA, {
        subjectEntityId: self.id,
        predicate: "prefers",
        objectText: "tea",
        provenance: "volunteered",
        confidence: 0.9,
        source: { sourceKind: "manual", sourceRef: "test:old", excerpt: "Prefers tea" }
      });
      const turn = await createTurn(scopedDb, {
        title: "Distill-supersede",
        user: "Actually, I prefer coffee, not tea."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "supersession",
              action: "supersede",
              fact: { subject: "Ben", predicate: "prefers", objectText: "coffee" },
              provenance: "volunteered",
              confidence: 0.9,
              importance: 0.9,
              sourceExcerpt: "Actually, I prefer coffee, not tea.",
              rationale: "Grounded correction",
              isSensitive: false,
              supersedesIds: [old.id, "11111111-1111-4111-8111-111111111111"]
            }
          ])
        }))
      );

      const active = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(active.some((fact) => fact.id === old.id)).toBe(false);
      expect(active.some((fact) => fact.objectText === "coffee")).toBe(true);
    });
  });

  it("does not supersede when only the model claims correction", async () => {
    await seedEconomyModel("model-only-supersede");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const self = await graphRepository.ensureSelfEntity(scopedDb, ids.userA);
      const old = await graphRepository.createFact(scopedDb, ids.userA, {
        subjectEntityId: self.id,
        predicate: "prefers",
        objectText: "tea",
        provenance: "volunteered",
        confidence: 0.9,
        source: {
          sourceKind: "manual",
          sourceRef: "test:model-only-old",
          excerpt: "Prefers tea"
        }
      });
      const turn = await createTurn(scopedDb, {
        title: "Distill-model-only-supersede",
        user: "Remember that I prefer coffee."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "supersession",
              action: "supersede",
              fact: { subject: "Ben", predicate: "prefers", objectText: "coffee" },
              provenance: "volunteered",
              confidence: 0.9,
              importance: 0.9,
              sourceExcerpt: "Remember that I prefer coffee.",
              rationale: "Model inferred correction",
              isSensitive: false,
              supersedesIds: [old.id]
            }
          ])
        }))
      );

      const active = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(active.some((fact) => fact.id === old.id)).toBe(true);
    });
  });

  it("ignores supersedesIds on non-supersession candidates", async () => {
    await seedEconomyModel("supersede-ignored");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const self = await graphRepository.ensureSelfEntity(scopedDb, ids.userA);
      const old = await graphRepository.createFact(scopedDb, ids.userA, {
        subjectEntityId: self.id,
        predicate: "prefers",
        objectText: "tea",
        provenance: "volunteered",
        confidence: 0.9,
        source: {
          sourceKind: "manual",
          sourceRef: "test:old-non-supersede",
          excerpt: "Prefers tea"
        }
      });
      const turn = await createTurn(scopedDb, {
        title: "Distill-ignore-supersedes",
        user: "Remember that I prefer coffee."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "fact",
              action: "create",
              fact: { subject: "Ben", predicate: "prefers", objectText: "coffee" },
              provenance: "volunteered",
              confidence: 0.9,
              importance: 0.9,
              sourceExcerpt: "Remember that I prefer coffee.",
              rationale: "Explicit memory request",
              isSensitive: false,
              supersedesIds: [old.id]
            }
          ])
        }))
      );

      const active = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(active.some((fact) => fact.id === old.id)).toBe(true);
      expect(active.some((fact) => fact.objectText === "coffee")).toBe(true);
    });
  });

  it("drops credential-like candidates before storing or promoting", async () => {
    await seedEconomyModel("secret-filter");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-secret",
        user: "Remember that my API key is sk-1234567890abcdef."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "fact",
              action: "create",
              fact: {
                subject: "Ben",
                predicate: "related_to",
                objectText: "api key sk-1234567890abcdef"
              },
              provenance: "volunteered",
              confidence: 0.99,
              importance: 0.9,
              sourceExcerpt: "Remember that my API key is sk-1234567890abcdef.",
              rationale: "User explicitly asked to remember credential.",
              isSensitive: false
            }
          ])
        }))
      );

      const pending = await candidatesRepository.listPending(scopedDb, ids.userA, 10);
      const core = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(JSON.stringify(pending)).not.toContain("sk-1234567890abcdef");
      expect(JSON.stringify(core)).not.toContain("sk-1234567890abcdef");
    });
  });

  it("does not send or store raw secret-like turns for distillation", async () => {
    await seedEconomyModel("raw-secret-filter");
    let calls = 0;
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-raw-secret",
        user: "Remember that my API key is sk-rawsecret1234567890."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => {
          calls++;
          return { text: "[]" };
        })
      );

      const leakedRows = await sql<{ count: string }>`
        SELECT count(*)::text AS count
        FROM app.memory_episodes
        WHERE owner_user_id = ${ids.userA}::uuid
          AND excerpt ILIKE '%sk-rawsecret1234567890%'
      `.execute(scopedDb.db);
      const leakedSearchRows = await sql<{ count: string }>`
        SELECT count(*)::text AS count
        FROM app.memory_search_documents
        WHERE owner_user_id = ${ids.userA}::uuid
          AND search_text ILIKE '%sk-rawsecret1234567890%'
      `.execute(scopedDb.db);

      expect(calls).toBe(0);
      expect(leakedRows.rows[0]?.count).toBe("0");
      expect(leakedSearchRows.rows[0]?.count).toBe("0");
    });
  });

  it("does not promote commitments into tasks or active memory", async () => {
    await seedEconomyModel("commitment");
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const turn = await createTurn(scopedDb, {
        title: "Distill-commitment",
        user: "Remember I need to follow up with Alex tomorrow."
      });

      await handleExtractFactsJob(
        scopedDb,
        ids.userA,
        {
          actorUserId: ids.userA,
          threadId: turn.threadId,
          userMessageId: turn.userMessage.id,
          assistantMessageId: turn.assistantMessage.id
        },
        makeDeps(async () => ({
          text: JSON.stringify([
            {
              kind: "fact",
              action: "create",
              fact: { subject: "Ben", predicate: "owes", objectText: "Alex a follow up" },
              provenance: "volunteered",
              confidence: 0.99,
              importance: 0.9,
              sourceExcerpt: "I need to follow up with Alex tomorrow.",
              rationale: "Commitment-like statement",
              isSensitive: false
            }
          ])
        }))
      );

      const pending = await candidatesRepository.listPending(scopedDb, ids.userA, 10);
      expect(pending).toContainEqual(expect.objectContaining({ status: "pending", kind: "fact" }));
      const core = await graphRepository.listCoreFacts(scopedDb, ids.userA, 50);
      expect(core.some((fact) => fact.objectText === "Alex a follow up")).toBe(false);
    });
  });

  it("recordTurn enqueues metadata-only message ids and skips incognito threads", async () => {
    const sent: Array<{ readonly queue: string; readonly payload: Record<string, unknown> }> = [];
    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository,
      boss: {
        send: async (queue: string, payload: Record<string, unknown>) => {
          sent.push({ queue, payload });
          return "job-id";
        }
      } as never
    });

    await persistence.openNewConversation(ids.userA);
    await persistence.recordTurn(
      ids.userA,
      "Remember that I prefer job payload metadata.",
      "Noted.",
      {
        provider: "anthropic",
        model: "claude-economy"
      }
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        queue: "chat.extract-facts",
        payload: expect.objectContaining({
          actorUserId: ids.userA,
          threadId: expect.any(String),
          userMessageId: expect.any(String),
          assistantMessageId: expect.any(String)
        })
      })
    );
    expect(JSON.stringify(sent)).not.toContain("prefer job payload metadata");

    sent.length = 0;
    await persistence.openNewConversation(ids.userA, { incognito: true });
    await persistence.recordTurn(ids.userA, "Remember nothing from incognito.", "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });
    expect(sent).toEqual([]);
  });

  it("does not derive a stored thread title from a secret-like first turn", async () => {
    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: repository,
      aiRepository
    });

    await persistence.openNewConversation(ids.userA);
    await persistence.recordTurn(ids.userA, "sk-titleSecret1234567890", "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });

    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const current = await repository.getCurrentThread(scopedDb, ids.userA);
      expect(current?.title).toBe("Conversation");
      expect(current?.title).not.toContain("sk-titleSecret1234567890");
    });
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-chat-live"
  };
}

function userBContext(): AccessContext {
  return {
    actorUserId: ids.userB,
    requestId: "request:user-b-chat-live"
  };
}

function adminContext(): AccessContext {
  return {
    actorUserId: ids.adminUser,
    requestId: "request:admin-chat-live"
  };
}
