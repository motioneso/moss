import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { DEFAULT_CHAT_SURFACE, type ChatSurface } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { ReminderRepository } from "../../packages/chat/src/reminders/repository.js";
import { ChatUnreadRepository } from "../../packages/chat/src/unread-repository.js";
import { registerChatUnreadRoutes } from "../../packages/chat/src/unread-routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const chat = new ChatRepository();
const unread = new ChatUnreadRepository();
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let app: DataContextRunner;
let worker: DataContextRunner;
const owner = <T>(work: (db: DataContextDb) => Promise<T>, actorUserId: string = ids.userA) =>
  app.withDataContext({ actorUserId }, work);

beforeAll(() => {
  appDb = createDatabase({ connectionString: connectionStrings.app });
  workerDb = createDatabase({ connectionString: connectionStrings.worker });
  app = new DataContextRunner(appDb);
  worker = new DataContextRunner(workerDb);
});
beforeEach(async () => {
  await resetFoundationDatabase();
});
afterAll(async () => {
  await Promise.all([appDb.destroy(), workerDb.destroy()]);
});

async function thread(actorUserId = ids.userA, incognito = false, surface = DEFAULT_CHAT_SURFACE) {
  return owner(
    (db) => chat.openNewThread(db, { title: "Unread test", incognito, surface }),
    actorUserId
  );
}
async function message(
  threadId: string,
  options: {
    actor?: string;
    role?: "user" | "assistant";
    status?: "stored" | "working";
    body?: string;
    worker?: boolean;
  } = {}
) {
  const actorUserId = options.actor ?? ids.userA;
  return (options.worker ? worker : app).withDataContext({ actorUserId }, (db) =>
    db.db
      .insertInto("app.chat_messages")
      .values({
        id: randomUUID(),
        thread_id: threadId,
        owner_user_id: actorUserId,
        role: options.role ?? "assistant",
        status: options.status ?? "stored",
        body: options.body ?? "A completed Moss message",
        model_metadata: {},
        tool_metadata: {}
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  );
}

describe("durable chat unread messages (#3520)", () => {
  it("counts complete assistant messages once, including worker reminder delivery", async () => {
    const main = await thread();
    expect((await owner((db) => unread.counts(db))).unreadCount).toBe(0);
    const reply = await message(main.id);
    const source = await message(main.id, { role: "user" });
    await message(main.id, { status: "working" });
    const reminder = await owner(async (db) => {
      const saved = await new ReminderRepository().create(db, {
        threadId: main.id,
        sourceMessageId: source.id,
        when: { timing: "relative", delaySeconds: 60 },
        text: "test delivery"
      });
      return db.db
        .selectFrom("app.chat_reminders")
        .selectAll()
        .where("id", "=", saved.id)
        .executeTakeFirstOrThrow();
    });
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      chat.insertReservedAssistantMessage(db, {
        id: reminder.reserved_message_id,
        threadId: main.id,
        body: "Reminder: test delivery",
        origin: { version: 1, kind: "reminder", event: "delivered", reminderId: reminder.id },
        now: new Date()
      })
    );
    expect(await owner((db) => unread.counts(db))).toEqual({
      unreadCount: 2,
      unreadByThread: { [main.id]: 2 }
    });
    await owner((db) => unread.markRead(db, main.id, [reply.id]));
    await owner((db) => unread.markRead(db, main.id, [reply.id]));
    expect((await owner((db) => unread.counts(db))).unreadCount).toBe(1);
  });

  it("marks only loaded IDs in the opened conversation, preserving concurrent and side arrivals", async () => {
    const main = await thread();
    const side = await thread();
    const loaded = await message(main.id);
    const arrivedDuringLoad = await message(main.id);
    const sideReply = await message(side.id);
    await owner((db) => unread.markRead(db, main.id, [loaded.id, sideReply.id]));
    expect(await owner((db) => unread.counts(db))).toEqual({
      unreadCount: 2,
      unreadByThread: { [main.id]: 1, [side.id]: 1 }
    });
    await owner((db) => unread.markRead(db, main.id, [arrivedDuringLoad.id]));
    await owner((db) => unread.markRead(db, main.id, [loaded.id]));
    expect(await owner((db) => unread.counts(db))).toEqual({
      unreadCount: 1,
      unreadByThread: { [side.id]: 1 }
    });
  });

  it("excludes private/module chats and synthetic empty action outcomes", async () => {
    const privateThread = await thread(ids.userA, true);
    const moduleThread = await thread(ids.userA, false, "module-test" as ChatSurface);
    const main = await thread();
    await message(privateThread.id);
    await message(moduleThread.id);
    await owner((db) =>
      chat.persistActionRecord(db, ids.userA, main.id, {
        kind: "action_result",
        actionRequestId: randomUUID(),
        text: "Done",
        outcome: "executed"
      })
    );
    expect((await owner((db) => unread.counts(db))).unreadCount).toBe(0);
  });

  it("counts working-to-stored completion without re-adding a read message on a stored update", async () => {
    const main = await thread();
    const pending = await message(main.id, { status: "working" });
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      db.db
        .updateTable("app.chat_messages")
        .set({ status: "stored" })
        .where("id", "=", pending.id)
        .execute()
    );
    expect((await owner((db) => unread.counts(db))).unreadCount).toBe(1);
    await owner((db) => unread.markRead(db, main.id, [pending.id]));
    await worker.withDataContext({ actorUserId: ids.userA }, (db) =>
      db.db
        .updateTable("app.chat_messages")
        .set({ status: "stored" })
        .where("id", "=", pending.id)
        .execute()
    );
    expect((await owner((db) => unread.counts(db))).unreadCount).toBe(0);
  });

  it("RLS hides another owner's receipts", async () => {
    const main = await thread();
    await message(main.id);
    const foreign = await owner(
      (db) => db.db.selectFrom("app.chat_unread_messages").selectAll().execute(),
      ids.userB
    );
    expect(foreign).toEqual([]);
  });

  it("RLS prevents another actor from clearing receipts", async () => {
    const main = await thread();
    const reply = await message(main.id);
    await owner((db) => unread.markRead(db, main.id, [reply.id]), ids.userB);
    expect((await owner((db) => unread.counts(db))).unreadCount).toBe(1);
  });

  it("RLS prevents another actor from inserting receipts", async () => {
    const main = await thread();
    const reply = await message(main.id);
    await owner((db) => unread.markRead(db, main.id, [reply.id]));
    await expect(
      owner(
        (db) =>
          db.db
            .insertInto("app.chat_unread_messages")
            .values({
              message_id: reply.id,
              thread_id: main.id,
              owner_user_id: ids.userA
            })
            .execute(),
        ids.userB
      )
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("returns authenticated counts, validates IDs, and rejects a foreign read target", async () => {
    const main = await thread();
    const reply = await message(main.id);
    const server = Fastify();
    registerChatUnreadRoutes(server, {
      dataContext: app,
      resolveAccessContext: async (request) => ({
        actorUserId: request.headers["x-actor"] === "other" ? ids.userB : ids.userA
      })
    });
    try {
      const response = await server.inject({ method: "GET", url: "/api/chat/unread" });
      expect(response.statusCode).toBe(200);
      expect(response.json().unreadCount).toBe(1);
      const url = `/api/chat/threads/${main.id}/read`;
      expect(
        (
          await server.inject({
            method: "POST",
            url,
            headers: { "x-actor": "other" },
            payload: { messageIds: [reply.id] }
          })
        ).statusCode
      ).toBe(404);
      expect(
        (await server.inject({ method: "POST", url, payload: { messageIds: ["invalid"] } }))
          .statusCode
      ).toBe(400);
      expect(
        (await server.inject({ method: "POST", url, payload: { messageIds: [reply.id] } }))
          .statusCode
      ).toBe(200);
      expect((await owner((db) => unread.counts(db))).unreadCount).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("uses forced RLS", async () => {
    const result = await owner((db) =>
      sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.chat_unread_messages'::regclass
    `.execute(db.db)
    );
    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("uses an invoker trigger rather than privileged data access", async () => {
    const trigger = await owner((db) =>
      sql<{ prosecdef: boolean }>`SELECT prosecdef FROM pg_proc
        WHERE oid = 'app.track_chat_unread_message()'::regprocedure`.execute(db.db)
    );
    expect(trigger.rows[0]).toEqual({ prosecdef: false });
  });
});
