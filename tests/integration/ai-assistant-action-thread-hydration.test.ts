import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import Fastify, { type FastifyInstance } from "fastify";

import { AiRepository, ConfirmationRegistry, registerAiRoutes } from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { AiAssistantActionDto } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("assistant action hydration origin", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let server: FastifyInstance;
  let threadA: string;
  let threadB: string;
  let otherOwnerThread: string;
  let actionA: string;
  let actionB: string;
  let unknownOriginAction: string;
  let otherOwnerAction: string;
  let orphanAction: string;
  const repository = new AiRepository();
  const chatRepository = new ChatRepository();
  const confirmations = new ConfirmationRegistry();
  const waitingActions: string[] = [];

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    server = Fastify();
    registerAiRoutes(server, {
      resolveAccessContext: async (request) => {
        const session = request.headers.authorization;
        const actorUserId =
          session === `Bearer ${ids.sessionB}`
            ? ids.userB
            : session === `Bearer ${ids.sessionAdmin}`
              ? ids.adminUser
              : ids.userA;
        return { actorUserId };
      },
      dataContext,
      resolveActiveModules: async () => [],
      repository,
      getActionRequestPresentation: (owner, id) => confirmations.getPresentation(owner, id)
    });
    await server.ready();

    threadA = await seedThread(ids.userA, "Conversation A");
    threadB = await seedThread(ids.userA, "Conversation B");
    otherOwnerThread = await seedThread(ids.userB, "Other owner conversation");
    actionA = await seedAction(ids.userA, threadA);
    actionB = await seedAction(ids.userA, threadB);
    unknownOriginAction = await seedAction(ids.userA);
    otherOwnerAction = await seedAction(ids.userB, otherOwnerThread);
    orphanAction = await seedAction(ids.userA, threadA, false);
  });

  afterAll(async () => {
    for (const id of waitingActions) confirmations.resolve(id, "cancelled");
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
  });

  async function seedThread(actorUserId: string, title: string): Promise<string> {
    return dataContext.withDataContext(
      { actorUserId },
      async (db) => (await chatRepository.openNewThread(db, { title })).id
    );
  }

  async function seedAction(
    actorUserId: string,
    chatThreadId?: string,
    awaiting = true
  ): Promise<string> {
    const id = await dataContext.withDataContext(
      { actorUserId },
      async (db) =>
        (
          await repository.createPendingAssistantAction(db, {
            chatThreadId,
            toolModuleId: "notes",
            toolModuleName: "Notes",
            toolName: "notes.write_note",
            permissionId: "notes.write",
            risk: "write",
            inputSummary: { text: "Approve note creation" }
          })
        ).id
    );
    if (awaiting) {
      waitingActions.push(id);
      void confirmations.awaitResolution(id, 300_000);
      confirmations.storePresentation(actorUserId, {
        kind: "action_request",
        actionRequestId: id,
        toolName: "notes.write_note",
        summary: "Save note",
        outcomeTitle: "Save note",
        details: {
          presentation: "human",
          target: "New note",
          fields: [{ label: "Content", value: "Approve note creation" }]
        },
        outsideContentNotice: false
      });
    }
    return id;
  }

  async function list(threadId?: string, session: string = ids.sessionA) {
    const response = await server.inject({
      method: "GET",
      url: `/api/ai/assistant-actions${threadId ? `?threadId=${threadId}` : ""}`,
      headers: { authorization: `Bearer ${session}` }
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ actions: AiAssistantActionDto[] }>().actions;
  }

  it("hydrates only pending actions from the chosen conversation", async () => {
    expect((await list(threadA)).map((action) => action.id).sort()).toEqual(
      [actionA, orphanAction].sort()
    );
    expect((await list(threadB)).map((action) => action.id)).toEqual([actionB]);
  });

  it("excludes legacy actions with unknown origin from both conversation filters", async () => {
    for (const threadId of [threadA, threadB]) {
      expect((await list(threadId)).map((action) => action.id)).not.toContain(unknownOriginAction);
    }
  });

  it("restores an orphaned pending row as decline-only without mutating its status", async () => {
    const orphaned = (await list(threadA)).find((action) => action.id === orphanAction);
    expect(orphaned).toMatchObject({
      approvalAvailable: false
    });
    expect(orphaned).not.toHaveProperty("presentation");
    const complete = confirmations.getPresentation(ids.userA, actionA);
    expect(complete).toBeDefined();
    if (!complete) throw new Error("Expected the complete live fixture presentation");
    try {
      confirmations.storePresentation(ids.userA, {
        kind: "action_request",
        actionRequestId: actionA,
        toolName: "notes.write_note",
        summary: "Save note",
        outsideContentNotice: false
      });
      const incomplete = (await list(threadA)).find((action) => action.id === actionA);
      expect(confirmations.isAwaiting(actionA)).toBe(true);
      expect(incomplete).toMatchObject({ approvalAvailable: false, status: "pending" });
      expect(incomplete).not.toHaveProperty("presentation");
    } finally {
      confirmations.storePresentation(ids.userA, complete);
    }
    expect((await list(threadA)).find((action) => action.id === actionA)).toMatchObject({
      approvalAvailable: true,
      presentation: {
        summary: "Save note",
        outcomeTitle: "Save note",
        details: {
          presentation: "human",
          target: "New note",
          fields: [{ label: "Content", value: "Approve note creation" }]
        }
      }
    });
    const orphan = await dataContext.withDataContext({ actorUserId: ids.userA }, (db) =>
      repository.getAssistantAction(db, orphanAction)
    );
    expect(orphan?.status).toBe("pending");
  });

  it("does not let another owner or an admin hydrate a guessed conversation id", async () => {
    expect(await list(threadA, ids.sessionB)).toEqual([]);
    expect(await list(threadA, ids.sessionAdmin)).toEqual([]);
    expect(await list(otherOwnerThread)).toEqual([]);
    expect((await list(otherOwnerThread, ids.sessionB)).map((action) => action.id)).toEqual([
      otherOwnerAction
    ]);
  });

  it("preserves the owner-wide activity list when no thread filter is provided", async () => {
    const actions = await list();
    expect(actions.map((action) => action.id).sort()).toEqual(
      [actionA, actionB, unknownOriginAction, orphanAction].sort()
    );
    expect(actions.every((action) => action.ownerUserId === ids.userA)).toBe(true);
  });

  it("returns no actions for a nonexistent conversation", async () => {
    expect(await list("62000000-0000-4000-8000-0000000000ff")).toEqual([]);
  });

  it.each(["not-a-thread", ""])(
    'rejects invalid thread filter "%s" rather than widening scope',
    async (threadId) => {
      const response = await server.inject({
        method: "GET",
        url: `/api/ai/assistant-actions?threadId=${threadId}`,
        headers: { authorization: `Bearer ${ids.sessionA}` }
      });
      expect(response.statusCode).toBe(400);
    }
  );
});
