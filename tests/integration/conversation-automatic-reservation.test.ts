import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let runner: DataContextRunner;
let store: ConversationProvenanceStore;
const reservations = "app.chat_automatic_action_reservations" as const;
const asActor = <T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>) =>
  runner.withDataContext({ actorUserId }, work);
const create = (actorUserId: string = ids.userA, incognito = false) =>
  asActor(actorUserId, (db) =>
    new ChatRepository().openNewThread(db, { title: randomUUID(), incognito })
  );
const read = (threadId: string, actorUserId: string = ids.userA) =>
  asActor(actorUserId, (db) =>
    db.db.selectFrom(reservations).selectAll().where("thread_id", "=", threadId).execute()
  );
const reserve = (threadId: string, actorUserId: string = ids.userA, reservationId = randomUUID()) =>
  asActor(actorUserId, async (db) => {
    await db.db
      .insertInto(reservations)
      .values({
        thread_id: threadId,
        owner_user_id: actorUserId,
        reservation_id: reservationId
      })
      .execute();
    return reservationId;
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForProvenanceLockWait(): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await sql<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query LIKE '%chat_conversation_provenance%'
        AND query LIKE '%for update%'
    ) AS waiting`.execute(bootstrap);
      expect(result.rows[0]?.waiting).toBe(true);
    },
    { timeout: 5_000, interval: 20 }
  );
}

class ProtectionFailure extends Error {}
function assertInvisible(rows: unknown[]) {
  if (rows.length) throw new ProtectionFailure("Reservation ownership isolation failed");
}
async function assertDenied(work: () => Promise<unknown>) {
  try {
    await work();
  } catch {
    return;
  }
  throw new ProtectionFailure("Reservation mutation was accepted");
}

beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  runner = new DataContextRunner(appDb);
  store = new ConversationProvenanceStore(runner);
});
afterAll(async () => {
  await Promise.all([appDb?.destroy(), bootstrap?.destroy()]);
});

describe("durable automatic execution reservations", () => {
  it("coordinates two store instances and refuses admission before outside content can return", async () => {
    const thread = await create();
    const entered = deferred<void>();
    const settle = deferred<void>();
    const restarted = new ConversationProvenanceStore(new DataContextRunner(appDb));
    const callback = vi.fn(async () => {
      entered.resolve();
      await settle.promise;
      return "executed once";
    });
    const first = store.runAutomatic(ids.userA, thread.id, callback);
    await entered.promise;
    try {
      const otherCallback = vi.fn();
      expect(await restarted.runAutomatic(ids.userA, thread.id, otherCallback)).toEqual({
        kind: "confirm"
      });
      expect(otherCallback).not.toHaveBeenCalled();
      expect(await restarted.isTainted(ids.userA, thread.id)).toBe(true);
      await expect(
        restarted.recordAdmission(ids.userA, thread.id, "attachment_read")
      ).rejects.toThrow("Conversation is unavailable for content admission");
      const provenance = await asActor(ids.userA, (db) =>
        db.db
          .selectFrom("app.chat_conversation_provenance")
          .select("tainted_at")
          .where("thread_id", "=", thread.id)
          .executeTakeFirstOrThrow()
      );
      expect(provenance.tainted_at).toBeNull();
      expect(await read(thread.id)).toHaveLength(1);
    } finally {
      settle.resolve();
      await first;
    }
    expect(await first).toEqual({ kind: "ran", value: "executed once" });
    expect(callback).toHaveBeenCalledOnce();
    expect(await read(thread.id)).toEqual([]);
    await store.recordAdmission(ids.userA, thread.id, "attachment_read");
    const afterAdmission = vi.fn();
    expect(await store.runAutomatic(ids.userA, thread.id, afterAdmission)).toEqual({
      kind: "confirm"
    });
    expect(afterAdmission).not.toHaveBeenCalled();
  });

  it("allows exactly one simultaneous claim, with the other store requiring confirmation", async () => {
    const thread = await create();
    const entered = deferred<void>();
    const settle = deferred<void>();
    const callback = vi.fn(async () => {
      entered.resolve();
      await settle.promise;
      return true;
    });
    const secondStore = new ConversationProvenanceStore(new DataContextRunner(appDb));
    const attempts = [
      store.runAutomatic(ids.userA, thread.id, callback),
      secondStore.runAutomatic(ids.userA, thread.id, callback)
    ];
    await entered.promise;
    try {
      expect(await Promise.race(attempts)).toEqual({ kind: "confirm" });
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      settle.resolve();
      await Promise.all(attempts);
    }
    expect(await Promise.all(attempts)).toEqual(
      expect.arrayContaining([{ kind: "ran", value: true }, { kind: "confirm" }])
    );
  });

  it("rechecks taint after waiting for the provenance lock", async () => {
    const thread = await create();
    const locked = deferred<void>();
    const release = deferred<void>();
    const admission = asActor(ids.userA, async (db) => {
      await db.db
        .selectFrom("app.chat_conversation_provenance")
        .select("thread_id")
        .where("thread_id", "=", thread.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await db.db
        .updateTable("app.chat_conversation_provenance")
        .set({ tainted_at: new Date(), first_admission_path: "attachment_read" })
        .where("thread_id", "=", thread.id)
        .execute();
    });
    await locked.promise;
    const callback = vi.fn();
    const attempt = store.runAutomatic(ids.userA, thread.id, callback);
    try {
      await waitForProvenanceLockWait();
    } finally {
      release.resolve();
      await admission;
    }
    expect(await attempt).toEqual({ kind: "confirm" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("checks reservations using a fresh statement after an admission lock wait", async () => {
    const thread = await create();
    const locked = deferred<void>();
    const release = deferred<void>();
    const reservationId = randomUUID();
    const acquisition = asActor(ids.userA, async (db) => {
      await db.db
        .selectFrom("app.chat_conversation_provenance")
        .select("thread_id")
        .where("thread_id", "=", thread.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await db.db
        .insertInto(reservations)
        .values({
          thread_id: thread.id,
          owner_user_id: ids.userA,
          reservation_id: reservationId
        })
        .execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const refused = expect(
      store.recordAdmission(ids.userA, thread.id, "attachment_read")
    ).rejects.toThrow("Conversation is unavailable for content admission");
    try {
      await waitForProvenanceLockWait();
    } finally {
      release.resolve();
      await acquisition;
    }
    await refused;
    expect((await read(thread.id))[0]?.reservation_id).toBe(reservationId);
  });

  it("lets a callback acquire a transaction with a one-connection pool", async () => {
    const thread = await create();
    const singleDb = createDatabase({
      connectionString: connectionStrings.app,
      maxConnections: 1,
      connectionTimeoutMillis: 1_000
    });
    try {
      const singleRunner = new DataContextRunner(singleDb);
      const singleStore = new ConversationProvenanceStore(singleRunner);
      const result = await singleStore.runAutomatic(ids.userA, thread.id, () =>
        singleRunner.withDataContext({ actorUserId: ids.userA }, async (db) => {
          const row = await db.db
            .selectFrom("app.chat_threads")
            .select("id")
            .where("id", "=", thread.id)
            .executeTakeFirstOrThrow();
          return row.id;
        })
      );
      expect(result).toEqual({ kind: "ran", value: thread.id });
      expect(await read(thread.id)).toEqual([]);
    } finally {
      await singleDb.destroy();
    }
  });

  it("keeps a committed crash reservation closed across restart, token revocation and elapsed time", async () => {
    const thread = await create();
    const reservationId = await reserve(thread.id);
    const tokens = new SessionTokenRegistry();
    const token = tokens.mint({
      actorUserId: ids.userA,
      threadId: thread.id,
      chatSessionId: randomUUID(),
      allowedToolNames: null
    });
    tokens.revoke(token);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    try {
      const restarted = new ConversationProvenanceStore(new DataContextRunner(appDb));
      const callback = vi.fn();
      expect(await restarted.runAutomatic(ids.userA, thread.id, callback)).toEqual({
        kind: "confirm"
      });
      expect(callback).not.toHaveBeenCalled();
      expect(await restarted.isTainted(ids.userA, thread.id)).toBe(true);
      await expect(
        restarted.recordAdmission(ids.userA, thread.id, "outside_agent_read")
      ).rejects.toThrow("Conversation is unavailable for content admission");
      expect(await read(thread.id)).toEqual([
        { thread_id: thread.id, owner_user_id: ids.userA, reservation_id: reservationId }
      ]);
      const fresh = await create();
      expect(await restarted.runAutomatic(ids.userA, fresh.id, async () => "new chat")).toEqual({
        kind: "ran",
        value: "new chat"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale release delete a different reservation", async () => {
    const thread = await create();
    const replacement = randomUUID();
    expect(
      await store.runAutomatic(ids.userA, thread.id, async () => {
        await asActor(ids.userA, async (db) => {
          await db.db.deleteFrom(reservations).where("thread_id", "=", thread.id).execute();
          await db.db
            .insertInto(reservations)
            .values({ thread_id: thread.id, owner_user_id: ids.userA, reservation_id: replacement })
            .execute();
        });
        return "completed";
      })
    ).toEqual({ kind: "ran", value: "completed" });
    expect((await read(thread.id))[0]?.reservation_id).toBe(replacement);
    expect(await store.runAutomatic(ids.userA, thread.id, vi.fn())).toEqual({ kind: "confirm" });
  });

  it("releases after callback failure without offering confirmation or executing twice", async () => {
    const thread = await create();
    const failure = new Error("handler failed after dispatch");
    const callback = vi.fn(async () => {
      throw failure;
    });
    await expect(store.runAutomatic(ids.userA, thread.id, callback)).rejects.toBe(failure);
    expect(callback).toHaveBeenCalledOnce();
    expect(await read(thread.id)).toEqual([]);
  });

  it("propagates cleanup failure and leaves a fail-closed reservation without duplicate execution", async () => {
    const thread = await create();
    let transactions = 0;
    const unavailableRelease: Pick<DataContextRunner, "withDataContext"> = {
      withDataContext: async (access, work) => {
        if (++transactions === 2) throw new Error("release unavailable");
        return runner.withDataContext(access, work);
      }
    };
    const callback = vi.fn(async () => "already executed");
    await expect(
      new ConversationProvenanceStore(unavailableRelease).runAutomatic(
        ids.userA,
        thread.id,
        callback
      )
    ).rejects.toThrow("release unavailable");
    expect(callback).toHaveBeenCalledOnce();
    expect(await read(thread.id)).toHaveLength(1);
    expect(await store.runAutomatic(ids.userA, thread.id, callback)).toEqual({ kind: "confirm" });
    expect(callback).toHaveBeenCalledOnce();
  });
});

describe("reservation ownership and lifecycle", () => {
  it.each([ids.userB, ids.adminUser])(
    "hides owner state and denies mutation to %s",
    async (actor) => {
      const thread = await create();
      await reserve(thread.id);
      await asActor(ids.userA, (db) =>
        sql`INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
      VALUES ('chat_thread', ${thread.id}::uuid, ${ids.userA}::uuid, ${actor}::uuid, 'manage')`.execute(
          db.db
        )
      );
      assertInvisible(await read(thread.id, actor));
      assertInvisible(
        await asActor(actor, (db) =>
          db.db
            .deleteFrom(reservations)
            .where("thread_id", "=", thread.id)
            .returning("thread_id")
            .execute()
        )
      );
      const callback = vi.fn();
      expect(await store.runAutomatic(actor, thread.id, callback)).toEqual({ kind: "confirm" });
      expect(callback).not.toHaveBeenCalled();
      expect(await read(thread.id)).toHaveLength(1);
    }
  );

  it("denies owner-column forgery and an actor-owned row for a foreign parent", async () => {
    const thread = await create();
    for (const rowOwner of [ids.userA, ids.userB]) {
      await assertDenied(() =>
        asActor(ids.userB, (db) =>
          db.db
            .insertInto(reservations)
            .values({ thread_id: thread.id, owner_user_id: rowOwner, reservation_id: randomUUID() })
            .execute()
        )
      );
    }
    expect(await read(thread.id)).toEqual([]);
  });

  it("forces owner-only RLS with no UPDATE, worker grant, expiry or content columns", async () => {
    const flags = await sql<{
      enabled: boolean;
      forced: boolean;
      can_update: boolean;
      worker_select: boolean;
    }>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced,
        has_table_privilege('jarvis_app_runtime', 'app.chat_automatic_action_reservations', 'UPDATE') AS can_update,
        has_table_privilege('jarvis_worker_runtime', 'app.chat_automatic_action_reservations', 'SELECT') AS worker_select
      FROM pg_class WHERE oid = 'app.chat_automatic_action_reservations'::regclass
    `.execute(appDb);
    expect(flags.rows).toEqual([
      { enabled: true, forced: true, can_update: false, worker_select: false }
    ]);
    expect(await appDb.selectFrom(reservations).selectAll().execute()).toEqual([]);
    const columns = await sql<{ attname: string }>`SELECT attname FROM pg_attribute
      WHERE attrelid = 'app.chat_automatic_action_reservations'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`.execute(
      appDb
    );
    expect(columns.rows.map((column) => column.attname)).toEqual([
      "thread_id",
      "owner_user_id",
      "reservation_id"
    ]);
    const thread = await create();
    await reserve(thread.id);
    await assertDenied(() =>
      asActor(ids.userA, (db) =>
        db.db
          .updateTable(reservations)
          .set({ reservation_id: randomUUID() })
          .where("thread_id", "=", thread.id)
          .execute()
      )
    );
  });

  it("cascades on private thread and user deletion", async () => {
    const thread = await create(ids.userA, true);
    await reserve(thread.id);
    await asActor(ids.userB, (db) =>
      sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${thread.id}::uuid)`.execute(db.db)
    );
    expect(await read(thread.id)).toHaveLength(1);
    await asActor(ids.userA, (db) =>
      sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${thread.id}::uuid)`.execute(db.db)
    );
    expect(
      await bootstrap
        .selectFrom(reservations)
        .selectAll()
        .where("thread_id", "=", thread.id)
        .execute()
    ).toEqual([]);
    const actor = randomUUID();
    await sql`INSERT INTO app.users (id, email) VALUES (${actor}::uuid, ${`reservation-${actor}@example.test`})`.execute(
      bootstrap
    );
    const other = await create(actor);
    await reserve(other.id, actor);
    await bootstrap.deleteFrom("app.users").where("id", "=", actor).execute();
    expect(
      await bootstrap
        .selectFrom(reservations)
        .selectAll()
        .where("thread_id", "=", other.id)
        .execute()
    ).toEqual([]);
  });
});

describe("rollback-only reservation negative controls", () => {
  it.each([ids.userB, ids.adminUser])(
    "owner isolation assertion fails without RLS for %s",
    async (actor) => {
      const thread = await create();
      await reserve(thread.id);
      await expect(
        bootstrap.transaction().execute(async (transaction) => {
          await sql`ALTER TABLE app.chat_automatic_action_reservations DISABLE ROW LEVEL SECURITY`.execute(
            transaction
          );
          await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
          await sql`SELECT set_config('app.actor_user_id', ${actor}, true)`.execute(transaction);
          assertInvisible(
            await transaction
              .selectFrom(reservations)
              .selectAll()
              .where("thread_id", "=", thread.id)
              .execute()
          );
          throw new Error("RLS removal did not defeat assertion");
        })
      ).rejects.toBeInstanceOf(ProtectionFailure);
      assertInvisible(await read(thread.id, actor));
    }
  );

  it("foreign-parent insertion assertion fails without its parent ownership check", async () => {
    const thread = await create();
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER POLICY chat_automatic_action_reservations_insert ON app.chat_automatic_action_reservations
        WITH CHECK (owner_user_id = app.current_actor_user_id())`.execute(transaction);
        await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
        await sql`SELECT set_config('app.actor_user_id', ${ids.userB}, true)`.execute(transaction);
        await assertDenied(() =>
          transaction
            .insertInto(reservations)
            .values({
              thread_id: thread.id,
              owner_user_id: ids.userB,
              reservation_id: randomUUID()
            })
            .execute()
        );
        throw new Error("Parent ownership removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    expect(await read(thread.id)).toEqual([]);
  });
});
