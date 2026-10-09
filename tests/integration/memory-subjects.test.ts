import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type ChatMessage,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";
import { ChatRepository, handleExtractFactsJob } from "@moss/chat";
import { AiRepository, createAiSecretCipher, type GenerateChatInput } from "@moss/ai";
import {
  GraphMemoryRecallService,
  MemoryCandidatesRepository,
  MemoryGraphRepository,
  StubEmbeddingProvider
} from "@moss/memory";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repo = new MemoryGraphRepository();
const chatRepository = new ChatRepository();
const aiRepository = new AiRepository();
const candidatesRepository = new MemoryCandidatesRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

const userA = (requestId: string): AccessContext => ({ actorUserId: ids.userA, requestId });

describe("memory fact subjects", () => {
  it("resolves a distilled fact subject to the entity it describes, not always Self", async () => {
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:fact-subject" },
      async (db) => {
        const self = await repo.ensureSelfEntity(db, ids.userA);
        const name = `Alex ${randomUUID()}`;

        expect(await repo.resolveSubjectEntityId(db, ids.userA, "self")).toBe(self.id);

        const alex = await repo.resolveSubjectEntityId(db, ids.userA, name);
        expect(alex).not.toBeNull();
        expect(alex).not.toBe(self.id);
        expect(await repo.resolveSubjectEntityId(db, ids.userA, name.toUpperCase())).toBe(alex);

        await repo.createEntity(db, ids.userA, { kind: "person", name: `Dup ${name}` });
        await repo.createEntity(db, ids.userA, { kind: "person", name: `Dup ${name}` });
        expect(await repo.resolveSubjectEntityId(db, ids.userA, `Dup ${name}`)).toBeNull();
      }
    );
  });

  it("names the person a recalled fact is about, and leaves the owner's facts unnamed", async () => {
    const service = new GraphMemoryRecallService(new StubEmbeddingProvider(), repo);
    const token = `zorblat${randomUUID().slice(0, 8)}`;
    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "memory-graph:recall-subject-name" },
      async (db) => {
        const sam = await repo.createEntity(db, ids.userA, {
          kind: "person",
          name: `Sam ${token}`
        });
        const source = { sourceKind: "manual" as const, sourceRef: "manual:subject", excerpt: "x" };
        await service.remember(db, ids.userA, {
          subjectEntityId: sam.id,
          predicate: "prefers",
          objectText: "tea",
          provenance: "confirmed",
          source
        });
        await service.remember(db, ids.userA, {
          predicate: "prefers",
          objectText: `coffee ${token}`,
          provenance: "confirmed",
          source
        });
        return {
          bySamName: await service.recall(db, ids.userA, `Sam ${token}`),
          core: await service.core(db, ids.userA)
        };
      }
    );

    expect(result.bySamName.items[0]).toMatchObject({
      text: "tea",
      subjectName: `Sam ${token}`
    });
    const own = result.core.items.find((item) => item.text === `coffee ${token}`);
    expect(own).toBeDefined();
    expect(own?.subjectName).toBeUndefined();
  });
});

describe("entity suggestions from chat", () => {
  async function createTurn(
    scopedDb: DataContextDb,
    title: string,
    user: string
  ): Promise<{ threadId: string; userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    const thread = await chatRepository.openNewThread(scopedDb, { title });
    const result = await chatRepository.recordCompletedTurn(scopedDb, thread.id, user, "Noted.", {
      provider: "anthropic",
      model: "claude-economy"
    });
    if (!result) throw new Error("turn not recorded");
    return { threadId: thread.id, ...result };
  }

  function makeDeps(generate: (input: GenerateChatInput) => Promise<{ readonly text: string }>) {
    return {
      aiRepository,
      cipher: createAiSecretCipher(),
      candidatesRepository,
      graphRepository: repo,
      createAdapter: () => ({ generateChat: generate })
    };
  }

  async function seedEconomyModel(): Promise<void> {
    const admin = { actorUserId: ids.adminUser, requestId: "request:subjects-admin" };
    const provider = await dataContext.withDataContext(admin, (db) =>
      aiRepository.createProvider(db, {
        providerKind: "anthropic",
        displayName: "Subjects summarizer",
        encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "subjects-key" })
      })
    );
    await dataContext.withDataContext(admin, (db) =>
      aiRepository.createModel(db, {
        providerConfigId: provider.id,
        providerModelId: "subjects-summarizer",
        displayName: "Subjects Summarizer",
        capabilities: ["summarization"],
        tier: "economy"
      })
    );
  }

  it("reuses an existing entity when a person is suggested again, so later facts about them save", async () => {
    await seedEconomyModel();
    await dataContext.withDataContext(userA("request:subjects-chat"), async (scopedDb) => {
      const name = `Morgan ${randomUUID()}`;
      const entityCandidate = {
        kind: "entity",
        action: "create",
        entity: { kind: "person", name, summary: "a colleague" },
        provenance: "volunteered",
        confidence: 0.8,
        importance: 0.9,
        sourceExcerpt: `Remember my colleague ${name}.`,
        rationale: "Explicit memory request",
        isSensitive: false
      };
      for (const label of ["first", "second"]) {
        const turn = await createTurn(
          scopedDb,
          `Distill-entity-${label}`,
          `Remember my colleague ${name}.`
        );
        await handleExtractFactsJob(
          scopedDb,
          ids.userA,
          {
            actorUserId: ids.userA,
            threadId: turn.threadId,
            userMessageId: turn.userMessage.id,
            assistantMessageId: turn.assistantMessage.id
          },
          makeDeps(async () => ({ text: JSON.stringify([entityCandidate]) }))
        );
      }

      expect(await repo.findEntitiesByName(scopedDb, ids.userA, name)).toHaveLength(1);

      const turn = await createTurn(
        scopedDb,
        "Distill-entity-fact",
        `Remember that ${name} prefers email.`
      );
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
              fact: { subject: name, predicate: "prefers", objectText: "email" },
              provenance: "volunteered",
              confidence: 0.8,
              importance: 0.9,
              sourceExcerpt: `Remember that ${name} prefers email.`,
              rationale: "Explicit memory request",
              isSensitive: false
            }
          ])
        }))
      );
      const core = await repo.listCoreFacts(scopedDb, ids.userA, 100);
      expect(core).toContainEqual(
        expect.objectContaining({ predicate: "prefers", objectText: "email" })
      );
    });
  });
});
