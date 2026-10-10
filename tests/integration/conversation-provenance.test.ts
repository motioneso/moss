import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import {
  ChatMemoryFactsRepository,
  GraphMemoryRecallService,
  MemoryRepository,
  MemoryRetriever,
  StubEmbeddingProvider
} from "@moss/memory";
import { settingsModuleManifest } from "@moss/settings";
import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { RecallService } from "../../packages/chat/src/recall-port.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { buildEngineText } from "../../packages/chat/src/live/engine-text.js";
import { NotesContextRetriever } from "../../packages/chat/src/live/notes-retrieval.js";
import { PassiveContextRetriever } from "../../packages/chat/src/live/passive-retrieval.js";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import {
  DEFAULT_CHAT_SURFACE,
  surfaceSessionKey
} from "../../packages/chat/src/live/chat-surface.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let runner: DataContextRunner;
let store: ConversationProvenanceStore;
let persistence: DataContextChatPersistence;
const threads = new ChatRepository();
const embeddings = new StubEmbeddingProvider();
const memory = new MemoryRepository();
const asActor = <T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>) =>
  runner.withDataContext({ actorUserId }, work);
const create = (actorUserId: string = ids.userA) =>
  asActor(actorUserId, (db) => threads.openNewThread(db, { title: randomUUID() }));
const binding = (threadId: string, actorUserId: string = ids.userA) => ({
  threadId,
  chatSessionId: surfaceSessionKey(actorUserId)
});

beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  runner = new DataContextRunner(appDb);
  store = new ConversationProvenanceStore(runner);
  persistence = new DataContextChatPersistence({
    dataContext: runner,
    chatRepository: threads,
    aiRepository: new AiRepository()
  });
});
afterAll(async () => {
  await appDb?.destroy();
});

// Real settings handler, approval storage, token identity and durable provenance. Only embeddings
// and the launch engine are local no-provider fakes; notes and memory come from actor-scoped SQL.
function themeGateway(threadId: string, actorUserId: string = ids.userA, trusted = true) {
  const tokens = new SessionTokenRegistry();
  const records: GatewaySessionRecord[] = [];
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [settingsModuleManifest],
    repository: new AiRepository(),
    runner,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: (_session, record) => records.push(record) },
    provenance: store,
    confirmTimeoutMs: 10_000,
    yoloMode: async () => trusted,
    actionPolicy: () => ({
      getFamilyTier: async () => (trusted ? "trusted_auto" : "ask_each_time"),
      getFamilyManifest: async (_moduleId, familyId) =>
        settingsModuleManifest.assistantActionFamilies?.find((family) => family.id === familyId) ??
        null
    })
  });
  const token = tokens.mint({
    actorUserId,
    threadId,
    chatSessionId: surfaceSessionKey(actorUserId),
    allowedToolNames: new Set(["settings.themeMode.set"])
  });
  return { gateway, token, records, actorUserId };
}

// The user's own trust runs writes after outside content (#3338). Turn it off so the card's
// outside-content notice shows whether the thread is tainted.
async function expectThemeApproval(threadId: string) {
  const h = themeGateway(threadId, ids.userA, false);
  const pending = h.gateway.callTool(h.token, "settings.themeMode.set", { mode: "dark" });
  await vi.waitFor(
    () => expect(h.records.some((record) => record.kind === "action_request")).toBe(true),
    { timeout: 5000 }
  );
  const request = h.records.find((record) => record.kind === "action_request")!;
  expect(request.outsideContentNotice).toBe(true);
  await h.gateway.resolveActionRequest(h.actorUserId, request.actionRequestId, "rejected");
  expect(await pending).toMatchObject({ ok: false, denied: true });
}

function sqlNotesRetriever() {
  const retriever = new MemoryRetriever(embeddings, memory);
  return new NotesContextRetriever({
    dataContext: runner,
    notesRecall: {
      recall: async (db, _owner, query, options) => ({
        snippets: (await retriever.retrieve(db, query, options.limit, "notes")).map((chunk) => ({
          sourcePath: chunk.sourcePath,
          updatedAt: chunk.updatedAt,
          score: chunk.similarity,
          text: chunk.text
        }))
      })
    }
  });
}

async function firstPath(threadId: string) {
  return asActor(
    ids.userA,
    async (db) =>
      (
        await db.db
          .selectFrom("app.chat_conversation_provenance")
          .select("first_admission_path")
          .where("thread_id", "=", threadId)
          .executeTakeFirstOrThrow()
      ).first_admission_path
  );
}

describe("non-tool context admission protects later writes", () => {
  it("automatic notes recall of a stored note asks for a later theme write without calling a notes tool", async () => {
    const thread = await create();
    const question = "What did we decide about the launch?";
    const sourcePath = `notes/admission-${randomUUID()}.md`;
    const vector = await embeddings.embedDocument(question);
    await asActor(ids.userA, (db) =>
      memory.upsertFileChunks(
        db,
        ids.userA,
        sourcePath,
        [
          {
            sourcePath,
            lineStart: 1,
            lineEnd: 2,
            contentHash: randomUUID(),
            text: question + " The launch is on Thursday.",
            embedding: vector
          }
        ],
        embeddings.modelName,
        embeddings.modelVersion,
        "notes"
      )
    );
    const runReadTool = vi.fn(async () => ({ ok: true, data: {} }));
    const text = await buildEngineText(
      {
        persistence,
        conversationProvenance: store,
        notesRetrieval: sqlNotesRetriever(),
        crossToolRead: { runReadTool }
      },
      ids.userA,
      question,
      DEFAULT_CHAT_SURFACE,
      binding(thread.id)
    );
    expect(text.text).toContain("The launch is on Thursday.");
    expect(runReadTool.mock.calls).not.toContainEqual(expect.arrayContaining(["notes.search"]));
    expect(await firstPath(thread.id)).toBe("recall_notes");
    await expectThemeApproval(thread.id);
  });

  it("passive graph-memory recall admits stored memory before a later theme write", async () => {
    const thread = await create();
    const graph = new GraphMemoryRecallService(embeddings);
    await asActor(ids.userA, (db) =>
      graph.remember(db, ids.userA, {
        predicate: "prefers",
        objectText: "concise launch summaries",
        confidence: 1,
        provenance: "confirmed",
        importance: 1,
        pinned: true,
        source: {
          sourceKind: "manual",
          sourceRef: `manual:${randomUUID()}`,
          sourceLabel: "Manual memory",
          excerpt: "Use concise launch summaries."
        }
      })
    );
    const text = await buildEngineText(
      {
        persistence,
        conversationProvenance: store,
        passiveRetrieval: new PassiveContextRetriever({ dataContext: runner, graphRecall: graph })
      },
      ids.userA,
      "Remember concise launch summaries",
      DEFAULT_CHAT_SURFACE,
      binding(thread.id)
    );
    expect(text.text).toContain("concise launch summaries");
    expect(await firstPath(thread.id)).toBe("recall_memory_turn");
    await expectThemeApproval(thread.id);
  });

  it("empty automatic memory, notes and cross-tool retrieval preserve a clean YOLO thread", async () => {
    const thread = await create(ids.userB);
    const graph = new GraphMemoryRecallService(embeddings);
    const h = themeGateway(thread.id, ids.userB);
    const text = await buildEngineText(
      {
        persistence,
        conversationProvenance: store,
        passiveRetrieval: new PassiveContextRetriever({ dataContext: runner, graphRecall: graph }),
        notesRetrieval: sqlNotesRetriever(),
        crossToolRead: {
          runReadTool: (actor, name, input, turnBinding) =>
            h.gateway.runReadToolForActor(actor, name, input, turnBinding)
        }
      },
      ids.userB,
      "Remember what I should focus on today",
      DEFAULT_CHAT_SURFACE,
      binding(thread.id, ids.userB)
    );
    expect(text.text).not.toContain("<retrieved_context>");
    expect(text.text).not.toContain("<cross_tool_context>");
    expect(await store.isTainted(ids.userB, thread.id)).toBe(false);
    expect(
      await h.gateway.callTool(h.token, "settings.themeMode.set", { mode: "light" })
    ).toMatchObject({ ok: true });
    expect(h.records.some((record) => record.kind === "action_request")).toBe(false);
    expect(await store.isTainted(ids.userB, thread.id)).toBe(false);
  });

  it("launch memory from stored facts records before the fake engine can receive its seed", async () => {
    const thread = await create();
    await asActor(ids.userA, (db) =>
      new ChatMemoryFactsRepository().insertFact(db, ids.userA, {
        category: "preference",
        content: "Launch memory marker",
        provenance: "confirmed"
      })
    );
    const launch = vi.fn(async () => {
      expect(await store.isTainted(ids.userA, thread.id)).toBe(true);
      return { offset: 0 };
    });
    const submit = vi.fn(async () => undefined);
    const manager = new ChatSessionManager({
      engineFactory: () => ({
        provider: "anthropic",
        launch,
        submit,
        readNew: async () => ({ records: [], offset: 0, complete: true }),
        isAlive: async () => true,
        kill: async () => undefined,
        interrupt: async () => undefined
      }),
      persistence: {
        resolveActiveProvider: async () => ({ provider: "anthropic", model: "default" }),
        getCurrentThreadState: async () => ({ id: thread.id, incognito: false }),
        listPriorTurns: persistence.listPriorTurns.bind(persistence),
        getThreadContext: persistence.getThreadContext.bind(persistence),
        recordTurn: persistence.recordTurn.bind(persistence),
        openNewConversation: persistence.openNewConversation.bind(persistence),
        touchExistingThread: persistence.touchExistingThread.bind(persistence)
      },
      conversationProvenance: store,
      recall: new RecallService(runner, embeddings),
      personaFs: { mkdir: async () => undefined, writeFile: async () => undefined },
      persona: "Trusted persona",
      clock: { now: () => 1 },
      idleMs: 1000,
      neutralBase: "/tmp/admission-integration",
      pollMs: 0
    });
    await manager.ensureSession(ids.userA, "Owner");
    expect(submit).toHaveBeenCalledWith(expect.stringContaining("Launch memory marker"));
    expect(await firstPath(thread.id)).toBe("launch_memory_seed");
    await expectThemeApproval(thread.id);
  });

  it("a turn's delayed admission stays on A after switching to clean B", async () => {
    const a = await create();
    const b = await create();
    let release!: (text: string) => void;
    const retrieving = vi.fn();
    const pending = buildEngineText(
      {
        persistence,
        conversationProvenance: store,
        passiveRetrieval: {
          retrieve: () => {
            retrieving();
            return new Promise<string>((resolve) => {
              release = resolve;
            });
          }
        }
      },
      ids.userA,
      "Remember this",
      DEFAULT_CHAT_SURFACE,
      binding(a.id)
    );
    await vi.waitFor(() => expect(retrieving).toHaveBeenCalledOnce());
    await asActor(ids.userA, (db) => threads.touchThread(db, b.id));
    release("Delayed memory marker");
    await pending;
    expect(await store.isTainted(ids.userA, a.id)).toBe(true);
    expect(await store.isTainted(ids.userA, b.id)).toBe(false);
    await expectThemeApproval(a.id);
    const clean = themeGateway(b.id);
    expect(
      await clean.gateway.callTool(clean.token, "settings.themeMode.set", { mode: "light" })
    ).toMatchObject({ ok: true });
    expect(clean.records.some((record) => record.kind === "action_request")).toBe(false);
    expect(await store.isTainted(ids.userA, b.id)).toBe(false);
  });
});
