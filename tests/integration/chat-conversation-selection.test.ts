import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AiRepository } from "@moss/ai";
import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

let app: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let runner: DataContextRunner;
const threads = new ChatRepository();
const owner = { actorUserId: ids.userA };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const create = () =>
  runner.withDataContext(owner, (db) => threads.openNewThread(db, { title: "selection proof" }));

beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  runner = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});

describe("bound completion and explicit conversation selection", () => {
  it.each(["resume", "new chat"] as const)(
    "a completion waiting behind %s saves A without selecting it over B",
    async (selection) => {
      const a = await create();
      const b = selection === "resume" ? await create() : undefined;
      await runner.withDataContext(owner, (db) => threads.touchThread(db, a.id));
      const selected = deferred<void>();
      const release = deferred<void>();
      let selectedId = "";
      const selecting = runner.withDataContext(owner, async (db) => {
        const next = b
          ? await threads.touchThread(db, b.id)
          : await threads.openNewThread(db, { title: "new selected conversation" });
        selectedId = next!.id;
        selected.resolve();
        await release.promise;
      });
      await Promise.race([selected.promise, selecting]);

      const connected = deferred<number>();
      const observedRunner = new (class extends DataContextRunner {
        override async withDataContext<T>(
          access: AccessContext,
          work: (db: DataContextDb) => Promise<T>
        ): Promise<T> {
          return super.withDataContext(access, async (db) => {
            const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
              db.db
            );
            connected.resolve(result.rows[0]!.pid);
            return work(db);
          });
        }
      })(app);
      const persistence = new DataContextChatPersistence({
        dataContext: observedRunner,
        chatRepository: threads,
        aiRepository: new AiRepository()
      });
      const completion = persistence.recordTurn(
        ids.userA,
        "A question",
        "A answer",
        { provider: "anthropic", model: "offline-fixture" },
        { threadId: a.id },
        DEFAULT_CHAT_SURFACE
      );
      try {
        const pid = await Promise.race([
          connected.promise,
          completion.then(() => {
            throw new Error("Completion finished before its database connection was observed");
          })
        ]);
        await vi.waitFor(
          async () => {
            const wait = await sql<{ wait_event: string | null }>`
          SELECT wait_event FROM pg_stat_activity WHERE pid = ${pid}
        `.execute(bootstrap);
            expect(wait.rows[0]?.wait_event).toBe("advisory");
          },
          { timeout: 5_000 }
        );
      } finally {
        release.resolve();
        await selecting;
        await completion;
      }

      await runner.withDataContext(owner, async (db) => {
        expect((await threads.getCurrentThread(db, ids.userA))?.id).toBe(selectedId);
        expect((await threads.listMessages(db, a.id)).map((message) => message.body)).toEqual([
          "A question",
          "A answer"
        ]);
        expect(await threads.listMessages(db, selectedId)).toEqual([]);
      });
    }
  );

  it("a still-current bound completion advances activity while retaining its selection", async () => {
    const a = await create();
    const before = await sql<{
      value: string;
    }>`SELECT last_active_at::text AS value FROM app.chat_threads WHERE id = ${a.id}::uuid`.execute(
      bootstrap
    );
    const persistence = new DataContextChatPersistence({
      dataContext: runner,
      chatRepository: threads,
      aiRepository: new AiRepository()
    });
    await persistence.recordTurn(
      ids.userA,
      "question",
      "answer",
      { provider: "anthropic", model: "offline-fixture" },
      { threadId: a.id }
    );
    const after = await sql<{
      advanced: boolean;
    }>`SELECT last_active_at > ${before.rows[0]!.value}::timestamptz AS advanced FROM app.chat_threads WHERE id = ${a.id}::uuid`.execute(
      bootstrap
    );
    expect(after.rows).toEqual([{ advanced: true }]);
    await runner.withDataContext(owner, async (db) => {
      expect((await threads.getCurrentThread(db, ids.userA))?.id).toBe(a.id);
    });
  });

  it("create and resume remain strictly ordered even when a previous activity time is ahead of the clock", async () => {
    const a = await create();
    await sql`UPDATE app.chat_threads SET last_active_at = clock_timestamp() + interval '1 day' WHERE id = ${a.id}::uuid`.execute(
      bootstrap
    );
    const b = await create();
    const ordered = () =>
      sql<{ later: boolean }>`SELECT
      (SELECT last_active_at FROM app.chat_threads WHERE id = ${b.id}::uuid) >
      (SELECT last_active_at FROM app.chat_threads WHERE id = ${a.id}::uuid) AS later`.execute(
        bootstrap
      );
    expect((await ordered()).rows).toEqual([{ later: true }]);
    await runner.withDataContext(owner, (db) => threads.touchThread(db, a.id));
    expect((await ordered()).rows).toEqual([{ later: false }]);
    await runner.withDataContext(owner, async (db) => {
      expect((await threads.getCurrentThread(db, ids.userA))?.id).toBe(a.id);
    });
  });
});
