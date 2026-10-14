import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, runSqlMigrations, type MossDatabase } from "@moss/db";
import { ChatRepository } from "@moss/chat";
import { normalizeChatSurface } from "@moss/shared";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("Main chat (#3125)", () => {
  let app: Kysely<MossDatabase>;
  let bootstrap: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  const threads = new ChatRepository();
  const owner = { actorUserId: ids.userC, requestId: "request:main-chat" };

  beforeAll(async () => {
    await resetFoundationDatabase();
    app = createDatabase({ connectionString: connectionStrings.app });
    bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
    runner = new DataContextRunner(app);
  });

  afterAll(async () => {
    await Promise.all([app?.destroy(), bootstrap?.destroy()]);
  });

  it("reopens the designated persistent drawer chat after side, private, module, and shared activity", async () => {
    const privateThread = await runner.withDataContext(owner, (db) =>
      threads.openNewThread(db, { title: "Private", incognito: true })
    );
    const moduleThread = await runner.withDataContext(owner, (db) =>
      threads.openNewThread(db, {
        title: "Meeting",
        surface: normalizeChatSurface("mtg-main-proof")
      })
    );
    const main = await runner.withDataContext(owner, async (db) => {
      const thread = await threads.openNewThread(db, { title: "Main" });
      await threads.recordCompletedTurn(db, thread.id, "remember this", "saved reply", {
        provider: "anthropic",
        model: "fixture"
      });
      return thread;
    });
    const side = await runner.withDataContext(owner, (db) =>
      threads.openNewThread(db, { title: "Later side chat" })
    );

    const foreignOwner = { actorUserId: ids.userB, requestId: "request:foreign-main-chat" };
    const foreign = await runner.withDataContext(foreignOwner, (db) =>
      threads.openNewThread(db, { title: "Foreign" })
    );
    await runner.withDataContext(foreignOwner, (db) =>
      db.db
        .insertInto("app.shares")
        .values({
          id: randomUUID(),
          resource_type: "chat_thread",
          resource_id: foreign.id,
          owner_user_id: ids.userB,
          grantee_user_id: ids.userC,
          level: "manage"
        })
        .execute()
    );

    await runner.withDataContext(owner, (db) => threads.touchThread(db, side.id));
    await runner.withDataContext(owner, (db) => threads.touchThread(db, privateThread.id));
    await runner.withDataContext(owner, (db) =>
      threads.touchThread(db, moduleThread.id, normalizeChatSurface("mtg-main-proof"))
    );

    const reconnected = new DataContextChatPersistence({
      dataContext: new DataContextRunner(app),
      chatRepository: threads,
      aiRepository: new AiRepository()
    });
    expect((await reconnected.getMainThreadState(ids.userC))?.id).toBe(main.id);
    expect((await reconnected.getMainThreadState(ids.userC))?.id).toBe(main.id);
    expect((await reconnected.getCurrentThreadState(ids.userC))?.id).toBe(privateThread.id);
    await runner.withDataContext(owner, async (db) => {
      expect(await threads.getThreadById(db, foreign.id)).toMatchObject({ id: foreign.id });
      expect(await threads.getOwnedThreadById(db, ids.userC, foreign.id)).toBeUndefined();
      expect([main, side, privateThread, moduleThread].map((thread) => thread.is_main)).toEqual([
        true,
        false,
        false,
        false
      ]);
      expect((await threads.listMessages(db, main.id)).map((message) => message.body)).toEqual([
        "remember this",
        "saved reply"
      ]);
    });
    await expect(
      runner.withDataContext(owner, (db) =>
        db.db
          .updateTable("app.chat_threads")
          .set({ is_main: false })
          .where("id", "=", foreign.id)
          .execute()
      )
    ).rejects.toThrow("only the chat owner can change the Main chat");
  });

  it("upgrades existing persistent drawer history under the migration role", async () => {
    await resetFoundationDatabase();
    const older = await runner.withDataContext(owner, async (db) => {
      const thread = await threads.openNewThread(db, { title: "Older drawer" });
      await threads.recordCompletedTurn(db, thread.id, "older question", "older reply", {
        provider: "anthropic",
        model: "fixture"
      });
      return thread;
    });
    const selected = await runner.withDataContext(owner, async (db) => {
      const thread = await threads.openNewThread(db, { title: "Selected drawer" });
      await threads.recordCompletedTurn(db, thread.id, "selected question", "selected reply", {
        provider: "anthropic",
        model: "fixture"
      });
      return thread;
    });
    const privateThread = await runner.withDataContext(owner, (db) =>
      threads.openNewThread(db, { title: "Private", incognito: true })
    );
    const moduleThread = await runner.withDataContext(owner, (db) =>
      threads.openNewThread(db, {
        title: "Meeting",
        surface: normalizeChatSurface("mtg-main-upgrade")
      })
    );
    const foreignOwner = { actorUserId: ids.userB, requestId: "request:foreign-upgrade" };
    const foreign = await runner.withDataContext(foreignOwner, (db) =>
      threads.openNewThread(db, { title: "Foreign" })
    );
    await runner.withDataContext(foreignOwner, (db) =>
      db.db
        .insertInto("app.shares")
        .values({
          id: randomUUID(),
          resource_type: "chat_thread",
          resource_id: foreign.id,
          owner_user_id: ids.userB,
          grantee_user_id: ids.userC,
          level: "manage"
        })
        .execute()
    );

    await bootstrap.transaction().execute(async (transaction) => {
      await sql`ALTER TABLE app.chat_threads DISABLE TRIGGER chat_threads_enforce_update_scope`.execute(
        transaction
      );
      await transaction
        .updateTable("app.chat_threads")
        .set({ is_main: false })
        .where("owner_user_id", "in", [ids.userB, ids.userC])
        .execute();
      await sql`ALTER TABLE app.chat_threads ENABLE TRIGGER chat_threads_enforce_update_scope`.execute(
        transaction
      );
    });
    await bootstrap
      .updateTable("app.chat_threads")
      .set({ last_active_at: new Date("2026-10-08T10:00:00Z") })
      .where("id", "=", older.id)
      .execute();
    await bootstrap
      .updateTable("app.chat_threads")
      .set({ last_active_at: new Date("2026-10-08T10:01:00Z") })
      .where("id", "=", selected.id)
      .execute();
    await bootstrap
      .updateTable("app.chat_threads")
      .set({ last_active_at: new Date("2026-10-08T10:02:00Z") })
      .where("id", "=", privateThread.id)
      .execute();
    await bootstrap
      .updateTable("app.chat_threads")
      .set({ last_active_at: new Date("2026-10-08T10:03:00Z") })
      .where("id", "=", moduleThread.id)
      .execute();
    await bootstrap
      .updateTable("app.chat_threads")
      .set({ last_active_at: new Date("2026-10-08T10:04:00Z") })
      .where("id", "=", foreign.id)
      .execute();
    await bootstrap.deleteFrom("app.schema_migrations").where("version", "=", "0299").execute();

    await runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: resolve(process.cwd(), "packages/chat/sql")
    });

    await runner.withDataContext(owner, async (db) => {
      expect((await threads.getMainThread(db, ids.userC))?.id).toBe(selected.id);
      expect((await threads.listMessages(db, older.id)).map((message) => message.body)).toEqual([
        "older question",
        "older reply"
      ]);
      expect((await threads.listMessages(db, selected.id)).map((message) => message.body)).toEqual([
        "selected question",
        "selected reply"
      ]);
      expect(await threads.getOwnedThreadById(db, ids.userC, foreign.id)).toBeUndefined();
    });
    const repeated = await runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: resolve(process.cwd(), "packages/chat/sql")
    });
    expect(repeated.applied).toEqual([]);
  });
});
