import { type Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { chatMessagesQuery } from "../../packages/settings/src/data-export-queries.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>;
let runner: DataContextRunner;
const repository = new ChatRepository();
const owner = { actorUserId: ids.userA };

beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  runner = new DataContextRunner(app);
});
afterAll(async () => app?.destroy());

it("orders equal-time messages by role before adversarial IDs in reload, archive and export", async () => {
  const thread = await runner.withDataContext(owner, (db) =>
    repository.openNewThread(db, { title: "Equal-time ordering" })
  );
  const now = new Date("2026-10-07T12:00:00.000Z");
  // Physical insertion order and UUID order both disagree with the required conversation order.
  const messages = [
    { id: "10000000-0000-4000-8000-000000009002", role: "assistant", body: "second reply" },
    { id: "f0000000-0000-4000-8000-000000009001", role: "user", body: "question" },
    { id: "10000000-0000-4000-8000-000000009001", role: "assistant", body: "first reply" }
  ] as const;
  await runner.withDataContext(owner, (db) =>
    db.db
      .insertInto("app.chat_messages")
      .values(
        messages.map((message) => ({
          ...message,
          thread_id: thread.id,
          owner_user_id: ids.userA,
          status: "stored" as const,
          model_metadata: {},
          tool_metadata: {},
          created_at: now,
          updated_at: now
        }))
      )
      .execute()
  );
  const expected = ["question", "first reply", "second reply"];
  const reload = await runner.withDataContext(owner, (db) =>
    repository.listMessages(db, thread.id)
  );
  expect(reload.map((message) => message.body)).toEqual(expected);
  expect(new Set(reload.map((message) => message.created_at.getTime())).size).toBe(1);
  const threads = await runner.withDataContext(owner, (db) => repository.listThreads(db));
  expect(threads.find((entry) => entry.id === thread.id)?.lastMessageBody).toBe("second reply");
  const archived = await runner.withDataContext(owner, (db) =>
    repository.listStoredMessagesInRange(
      db,
      ids.userA,
      "2026-10-07T00:00:00Z",
      "2026-10-08T00:00:00Z"
    )
  );
  expect(
    archived.filter((message) => message.threadId === thread.id).map((message) => message.body)
  ).toEqual(expected);
  const exported = await runner.withDataContext(owner, (db) =>
    chatMessagesQuery(ids.userA).execute(db.db)
  );
  expect(
    exported.rows.filter((message) => message.threadId === thread.id).map((message) => message.body)
  ).toEqual(expected);
});
