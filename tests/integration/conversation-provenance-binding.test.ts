import { randomUUID } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type ConversationProvenancePort,
  type GatewaySessionRecord
} from "@moss/ai";
import type { MossModuleManifest } from "@moss/module-sdk";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { fixtureApproval } from "./fixtures/approval-presentation.js";
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
const threads = new ChatRepository();
const table = "app.chat_conversation_provenance" as const;
const asActor = <T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>) =>
  runner.withDataContext({ actorUserId }, work);
const create = (incognito = false) =>
  asActor(ids.userA, (db) => threads.openNewThread(db, { title: randomUUID(), incognito }));
const read = (threadId: string, actorUserId: string = ids.userA) =>
  asActor(actorUserId, (db) =>
    db.db.selectFrom(table).selectAll().where("thread_id", "=", threadId).execute()
  );
async function legacyThread(): Promise<string> {
  const threadId = randomUUID();
  // Reproduce a pre-migration thread. Disabling only this trigger is confined to
  // the bootstrap transaction, and restored before commit (or by rollback).
  await bootstrap.transaction().execute(async (transaction) => {
    await sql`ALTER TABLE app.chat_threads DISABLE TRIGGER chat_threads_initialize_provenance`.execute(
      transaction
    );
    await sql`INSERT INTO app.chat_threads (id, owner_user_id, title)
        VALUES (${threadId}::uuid, ${ids.userA}::uuid, 'legacy conversation')`.execute(transaction);
    await sql`ALTER TABLE app.chat_threads ENABLE TRIGGER chat_threads_initialize_provenance`.execute(
      transaction
    );
  });
  return threadId;
}
async function assumeActor(transaction: Transaction<MossDatabase>, actorUserId: string) {
  await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
  await sql`SELECT set_config('app.actor_user_id', ${actorUserId}, true)`.execute(transaction);
}
class ProtectionFailure extends Error {}
function assertInvisible(rows: unknown[]) {
  if (rows.length) throw new ProtectionFailure("Conversation provenance isolation failed");
}
async function assertDenied(work: () => Promise<unknown>) {
  try {
    await work();
  } catch {
    return;
  }
  throw new ProtectionFailure("Conversation provenance mutation was accepted");
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

describe("conversation provenance ownership and lifecycle", () => {
  it("creates a clean row with a new thread, and rolls back both together", async () => {
    const fresh = await create();
    expect(await store.isTainted(ids.userA, fresh.id)).toBe(false);
    expect(await read(fresh.id)).toEqual([
      expect.objectContaining({
        thread_id: fresh.id,
        owner_user_id: ids.userA,
        tainted_at: null,
        first_admission_path: null
      })
    ]);
    let rolledBackId = "";
    await expect(
      asActor(ids.userA, async (db) => {
        const thread = await threads.openNewThread(db, { title: "roll back new conversation" });
        rolledBackId = thread.id;
        throw new Error("rollback probe");
      })
    ).rejects.toThrow("rollback probe");
    expect(await read(rolledBackId)).toEqual([]);
    expect(
      await bootstrap
        .selectFrom("app.chat_threads")
        .select("id")
        .where("id", "=", rolledBackId)
        .execute()
    ).toEqual([]);
  });

  it("treats missing binding, nonexistent thread and legacy thread without a row as tainted", async () => {
    const legacy = await legacyThread();
    expect(await store.isTainted(ids.userA, undefined)).toBe(true);
    expect(await store.isTainted(ids.userA, randomUUID())).toBe(true);
    expect(await store.isTainted(ids.userA, legacy)).toBe(true);
    expect(await read(legacy)).toEqual([]);
    await store.recordAdmission(ids.userA, legacy, "tool_external_content");
    expect(await read(legacy)).toEqual([
      expect.objectContaining({
        tainted_at: expect.any(Date),
        first_admission_path: "tool_external_content"
      })
    ]);
  });

  it("preserves the first admission across repeated and concurrent writes, resume and restart", async () => {
    const a = await create();
    await store.recordAdmission(ids.userA, a.id, "app_action_outside");
    const first = await read(a.id);
    await Promise.all([
      store.recordAdmission(ids.userA, a.id, "attachment_read"),
      store.recordAdmission(ids.userA, a.id, "outside_agent_read")
    ]);
    const b = await create();
    await asActor(ids.userA, (db) => threads.touchThread(db, b.id));
    const restarted = new ConversationProvenanceStore(new DataContextRunner(appDb));
    expect(await restarted.isTainted(ids.userA, a.id)).toBe(true);
    expect(await restarted.isTainted(ids.userA, b.id)).toBe(false);
    expect(await read(a.id)).toEqual(first);
  });

  it.each([ids.userB, ids.adminUser])(
    "hides state from non-owner %s even when the thread is shared",
    async (actor) => {
      const thread = await create();
      await asActor(ids.userA, (db) =>
        sql`INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
          VALUES ('chat_thread', ${thread.id}::uuid, ${ids.userA}::uuid, ${actor}::uuid, 'manage')`.execute(
          db.db
        )
      );
      expect(await store.isTainted(actor, thread.id)).toBe(true);
      assertInvisible(await read(thread.id, actor));
      const changed = await asActor(actor, (db) =>
        db.db
          .updateTable(table)
          .set({ tainted_at: new Date(), first_admission_path: "forged" })
          .where("thread_id", "=", thread.id)
          .returning("thread_id")
          .execute()
      );
      assertInvisible(changed);
      await expect(
        store.recordAdmission(actor, thread.id, "tool_external_content")
      ).rejects.toThrow("Conversation is unavailable for content admission");
      expect(await store.isTainted(ids.userA, thread.id)).toBe(false);
    }
  );

  it("rejects owner-column forgery and an actor-owned row pointing to a foreign parent", async () => {
    const legacy = await legacyThread();
    for (const rowOwner of [ids.userA, ids.userB]) {
      await assertDenied(() =>
        asActor(ids.userB, (db) =>
          db.db
            .insertInto(table)
            .values({
              thread_id: legacy,
              owner_user_id: rowOwner,
              tainted_at: new Date(),
              first_admission_path: "attachment_read"
            })
            .execute()
        )
      );
    }
    expect(await read(legacy)).toEqual([]);
  });

  it("cannot invent clean provenance for a legacy thread through the runtime role", async () => {
    const legacy = await legacyThread();
    await assertDenied(() =>
      asActor(ids.userA, (db) =>
        db.db.insertInto(table).values({ thread_id: legacy, owner_user_id: ids.userA }).execute()
      )
    );
    expect(await store.isTainted(ids.userA, legacy)).toBe(true);
    expect(await read(legacy)).toEqual([]);
  });

  it("initializes direct runtime thread inserts through the trigger, with no callable clean helper", async () => {
    const threadId = randomUUID();
    await asActor(ids.userA, (db) =>
      sql`INSERT INTO app.chat_threads (id, owner_user_id, title)
          VALUES (${threadId}::uuid, ${ids.userA}::uuid, 'direct new thread')`.execute(db.db)
    );
    expect(await store.isTainted(ids.userA, threadId)).toBe(false);
    const privilege = await sql<{ allowed: boolean }>`
      SELECT has_function_privilege('jarvis_app_runtime',
        'app.initialize_chat_conversation_provenance()', 'EXECUTE') AS allowed
    `.execute(appDb);
    expect(privilege.rows).toEqual([{ allowed: false }]);
    const legacy = await legacyThread();
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`SET LOCAL ROLE jarvis_migration_owner`.execute(transaction);
        await transaction
          .insertInto(table)
          .values({ thread_id: legacy, owner_user_id: ids.userA })
          .execute();
      })
    ).rejects.toThrow();
  });

  it("rejects a missing parent admission rather than reporting it recorded", async () => {
    await expect(store.recordAdmission(ids.userA, randomUUID(), "attachment_read")).rejects.toThrow(
      "Conversation is unavailable for content admission"
    );
  });

  it("cannot reset taint, replace its first stamp, change identity or delete then reinsert", async () => {
    const a = await create();
    const legacy = await legacyThread();
    await store.recordAdmission(ids.userA, a.id, "attachment_read");
    const before = await read(a.id);
    const changes = [
      { tainted_at: null, first_admission_path: null },
      { tainted_at: new Date("2001-01-01T00:00:00Z") },
      { first_admission_path: "outside_agent_read" },
      { thread_id: legacy },
      { owner_user_id: ids.userB },
      { created_at: new Date("2001-01-01T00:00:00Z") }
    ];
    for (const change of changes) {
      await assertDenied(() =>
        asActor(ids.userA, (db) =>
          db.db.updateTable(table).set(change).where("thread_id", "=", a.id).execute()
        )
      );
    }
    await assertDenied(() =>
      asActor(ids.userA, (db) => db.db.deleteFrom(table).where("thread_id", "=", a.id).execute())
    );
    expect(await read(a.id)).toEqual(before);
  });

  it("forces row security and grants no direct delete, including to the worker", async () => {
    const flags = await sql<{
      enabled: boolean;
      forced: boolean;
      can_delete: boolean;
      worker_select: boolean;
    }>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced,
        has_table_privilege('jarvis_app_runtime', 'app.chat_conversation_provenance', 'DELETE') AS can_delete,
        has_table_privilege('jarvis_worker_runtime', 'app.chat_conversation_provenance', 'SELECT') AS worker_select
      FROM pg_class WHERE oid = 'app.chat_conversation_provenance'::regclass
    `.execute(appDb);
    expect(flags.rows).toEqual([
      { enabled: true, forced: true, can_delete: false, worker_select: false }
    ]);
    expect(await appDb.selectFrom(table).selectAll().execute()).toEqual([]);
  });

  it("private cleanup cascades provenance only for the owning actor", async () => {
    const thread = await create(true);
    await store.recordAdmission(ids.userA, thread.id, "attachment_read");
    await asActor(ids.userB, (db) =>
      sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${thread.id}::uuid)`.execute(db.db)
    );
    expect(await read(thread.id)).toHaveLength(1);
    await asActor(ids.userA, (db) =>
      sql`SELECT app.delete_incognito_chat_thread_for_cleanup(${thread.id}::uuid)`.execute(db.db)
    );
    expect(
      await bootstrap.selectFrom(table).selectAll().where("thread_id", "=", thread.id).execute()
    ).toEqual([]);
    expect(await store.isTainted(ids.userA, thread.id)).toBe(true);
  });

  it("account deletion cascades conversation provenance", async () => {
    const actor = randomUUID();
    await sql`INSERT INTO app.users (id, email) VALUES (${actor}::uuid, ${`provenance-${actor}@example.test`})`.execute(
      bootstrap
    );
    const thread = await asActor(actor, (db) =>
      threads.openNewThread(db, { title: "deleted account" })
    );
    await store.recordAdmission(actor, thread.id, "attachment_read");
    await bootstrap.deleteFrom("app.users").where("id", "=", actor).execute();
    expect(
      await bootstrap.selectFrom(table).selectAll().where("thread_id", "=", thread.id).execute()
    ).toEqual([]);
  });
});

describe("rollback-only provenance negative controls", () => {
  it("clean legacy insertion assertion fails if the tainted-only INSERT check is removed", async () => {
    const legacy = await legacyThread();
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER POLICY chat_conversation_provenance_insert ON app.chat_conversation_provenance
          WITH CHECK (owner_user_id = app.current_actor_user_id() AND EXISTS (
            SELECT 1 FROM app.chat_threads thread
            WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
          ))`.execute(transaction);
        await assumeActor(transaction, ids.userA);
        await assertDenied(() =>
          transaction
            .insertInto(table)
            .values({ thread_id: legacy, owner_user_id: ids.userA })
            .execute()
        );
        throw new Error("Clean insertion removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    expect(await read(legacy)).toEqual([]);
    expect(await store.isTainted(ids.userA, legacy)).toBe(true);
  });

  it("new-thread clean assertion fails without the initializer, and rollback restores it", async () => {
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER TABLE app.chat_threads DISABLE TRIGGER chat_threads_initialize_provenance`.execute(
          transaction
        );
        await assumeActor(transaction, ids.userA);
        const id = randomUUID();
        await sql`INSERT INTO app.chat_threads (id, owner_user_id, title)
          VALUES (${id}::uuid, ${ids.userA}::uuid, 'initializer removal')`.execute(transaction);
        const row = await transaction
          .selectFrom(table)
          .select("tainted_at")
          .where("thread_id", "=", id)
          .executeTakeFirst();
        if (!row || row.tainted_at !== null)
          throw new ProtectionFailure("New thread was not initialized clean");
        throw new Error("Initializer removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    expect(await store.isTainted(ids.userA, (await create()).id)).toBe(false);
  });

  it.each([ids.userB, ids.adminUser])(
    "isolation assertion fails with RLS removed for %s, then is restored",
    async (actor) => {
      const thread = await create();
      await expect(
        bootstrap.transaction().execute(async (transaction) => {
          await sql`ALTER TABLE app.chat_conversation_provenance DISABLE ROW LEVEL SECURITY`.execute(
            transaction
          );
          await assumeActor(transaction, actor);
          const rows = await transaction
            .selectFrom(table)
            .selectAll()
            .where("thread_id", "=", thread.id)
            .execute();
          expect(rows).toHaveLength(1);
          assertInvisible(rows);
          throw new Error("RLS removal did not defeat assertion");
        })
      ).rejects.toBeInstanceOf(ProtectionFailure);
      assertInvisible(await read(thread.id, actor));
    }
  );

  it("foreign-parent insertion assertion fails when its policy check is removed, then is restored", async () => {
    const legacy = await legacyThread();
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER POLICY chat_conversation_provenance_insert ON app.chat_conversation_provenance
        WITH CHECK (owner_user_id = app.current_actor_user_id() AND tainted_at IS NOT NULL)`.execute(
          transaction
        );
        await assumeActor(transaction, ids.userB);
        await assertDenied(() =>
          transaction
            .insertInto(table)
            .values({
              thread_id: legacy,
              owner_user_id: ids.userB,
              tainted_at: new Date(),
              first_admission_path: "attachment_read"
            })
            .execute()
        );
        throw new Error("Parent ownership removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    await assertDenied(() =>
      asActor(ids.userB, (db) =>
        db.db
          .insertInto(table)
          .values({
            thread_id: legacy,
            owner_user_id: ids.userB,
            tainted_at: new Date(),
            first_admission_path: "attachment_read"
          })
          .execute()
      )
    );
  });

  it("reset assertion fails when the immutable trigger and non-null policy are removed, then is restored", async () => {
    const thread = await create();
    await store.recordAdmission(ids.userA, thread.id, "attachment_read");
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER TABLE app.chat_conversation_provenance DISABLE TRIGGER chat_conversation_provenance_prevent_rewrite`.execute(
          transaction
        );
        await sql`ALTER POLICY chat_conversation_provenance_update ON app.chat_conversation_provenance
        WITH CHECK (owner_user_id = app.current_actor_user_id())`.execute(transaction);
        await assumeActor(transaction, ids.userA);
        await assertDenied(() =>
          transaction
            .updateTable(table)
            .set({ tainted_at: null, first_admission_path: null })
            .where("thread_id", "=", thread.id)
            .execute()
        );
        throw new Error("Reset protection removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    expect(await store.isTainted(ids.userA, thread.id)).toBe(true);
  });

  it("first-admission rewrite assertion fails without the immutable trigger, then is restored", async () => {
    const thread = await create();
    await store.recordAdmission(ids.userA, thread.id, "attachment_read");
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER TABLE app.chat_conversation_provenance DISABLE TRIGGER chat_conversation_provenance_prevent_rewrite`.execute(
          transaction
        );
        await assumeActor(transaction, ids.userA);
        await assertDenied(() =>
          transaction
            .updateTable(table)
            .set({ first_admission_path: "outside_agent_read" })
            .where("thread_id", "=", thread.id)
            .execute()
        );
        throw new Error("First-admission protection removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    expect((await read(thread.id))[0]?.first_admission_path).toBe("attachment_read");
  });

  it("delete assertion fails with a delete grant and policy, then is restored", async () => {
    const thread = await create();
    await store.recordAdmission(ids.userA, thread.id, "attachment_read");
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`GRANT DELETE ON app.chat_conversation_provenance TO jarvis_app_runtime`.execute(
          transaction
        );
        await sql`CREATE POLICY chat_provenance_negative_control_delete ON app.chat_conversation_provenance
        FOR DELETE TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id())`.execute(
          transaction
        );
        await assumeActor(transaction, ids.userA);
        await assertDenied(() =>
          transaction.deleteFrom(table).where("thread_id", "=", thread.id).execute()
        );
        throw new Error("Delete protection removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(ProtectionFailure);
    expect(await store.isTainted(ids.userA, thread.id)).toBe(true);
  });
});

// The handler is a no-provider sentinel. Provenance lookups, action rows, ownership and
// confirmation use the real SQL-backed production classes in the isolated CI database.
// The sentinel is an owned connected tool that sends data out, so YOLO and trusted-auto run it
// only in a clean conversation (#3338).
function boundGateway(
  actorUserId: string,
  threadId: string | null,
  pausePolicy?: () => Promise<void>,
  provenance: ConversationProvenancePort = new ConversationProvenanceStore(runner)
) {
  const calls = vi.fn(async () => ({ data: { changed: true } }));
  const family = {
    id: "write",
    label: "Write",
    description: "Local write",
    defaultTier: "ask_each_time" as const,
    allowedTiers: ["ask_each_time", "trusted_auto"] as const
  };
  const module: MossModuleManifest = {
    id: "provenance-test",
    name: "Provenance test",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantActionFamilies: [family],
    assistantTools: [
      {
        name: "provenance-test.write",
        ...fixtureApproval("Record local sentinel write", "Provenance test sentinel"),
        description: "Local sentinel write",
        permissionId: "provenance-test.write",
        risk: "outbound",
        content: "user_authored",
        isExternal: true,
        descriptorOwnerUserId: actorUserId,
        executionPolicy: "auto",
        actionFamilyId: family.id,
        inputSchema: { type: "object", properties: {} },
        execute: calls
      }
    ]
  };
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const records: GatewaySessionRecord[] = [];
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [module],
    repository: new AiRepository(),
    runner,
    tokens,
    confirmations,
    notifier: { emit: (_session, record) => records.push(record) },
    provenance,
    confirmTimeoutMs: 10_000,
    yoloMode: async () => {
      await pausePolicy?.();
      return true;
    },
    actionPolicy: () => ({
      getFamilyTier: async () => "trusted_auto",
      getFamilyManifest: async () => family
    })
  });
  const token = tokens.mint({
    actorUserId,
    threadId,
    chatSessionId: randomUUID(),
    allowedToolNames: null
  });
  return { gateway, token, records, calls };
}

async function expectPending(h: ReturnType<typeof boundGateway>) {
  const call = h.gateway.callTool(h.token, "provenance-test.write", {});
  await vi.waitFor(
    () => expect(h.records.some((row) => row.kind === "action_request")).toBe(true),
    { timeout: 5_000 }
  );
  expect(h.calls).not.toHaveBeenCalled();
  const record = h.records.find((row) => row.kind === "action_request")!;
  await h.gateway.resolveActionRequest(ids.userA, record.actionRequestId, "rejected");
  expect(await call).toMatchObject({ ok: false, denied: true });
  expect(h.calls).not.toHaveBeenCalled();
}

describe("gateway decisions use durable token-bound conversation state", () => {
  it("requires approval for a missing thread id even with YOLO and trusted-auto", async () => {
    await expectPending(boundGateway(ids.userA, null));
  });

  it("keeps in-flight tainted A bound after resuming clean B", async () => {
    const a = await create();
    const b = await create();
    await store.recordAdmission(ids.userA, a.id, "tool_external_content");
    await asActor(ids.userA, (db) => threads.touchThread(db, a.id));
    const inFlight = boundGateway(ids.userA, a.id);
    await asActor(ids.userA, (db) => threads.touchThread(db, b.id));
    expect(await store.isTainted(ids.userA, b.id)).toBe(false);
    await expectPending(inFlight);
    const clean = boundGateway(ids.userA, b.id);
    expect(await clean.gateway.callTool(clean.token, "provenance-test.write", {})).toMatchObject({
      ok: true
    });
    expect(clean.calls).toHaveBeenCalledOnce();
  });

  it.each(["execute", "dry-run"] as const)(
    "gate %s declines tainted, missing and foreign bindings",
    async (mode) => {
      const a = await create();
      const cleanForeign = await create();
      expect(await store.isTainted(ids.userA, cleanForeign.id)).toBe(false);
      await store.recordAdmission(ids.userA, a.id, "attachment_read");
      for (const [actor, thread] of [
        [ids.userA, a.id],
        [ids.userA, null],
        [ids.userB, cleanForeign.id]
      ] as const) {
        const h = boundGateway(actor, thread);
        expect(await h.gateway.callToolForGate(h.token, "provenance-test.write", {}, mode)).toEqual(
          { kind: "declined", reason: "would_confirm" }
        );
        expect(h.calls).not.toHaveBeenCalled();
        expect(h.records).toEqual([]);
      }
    }
  );

  it("uses the same durable taint in a restarted gateway and token manager", async () => {
    const a = await create();
    await store.recordAdmission(ids.userA, a.id, "app_action_outside");
    await expectPending(boundGateway(ids.userA, a.id));
    await expectPending(boundGateway(ids.userA, a.id));
  });

  it("the foreign-binding gateway assertion fails for a deliberately leaky clean-row lookup", async () => {
    const ownedClean = await create();
    expect(await store.isTainted(ids.userA, ownedClean.id)).toBe(false);
    const assertForeignRefused = async (provenance: ConversationProvenancePort) => {
      const h = boundGateway(ids.userB, ownedClean.id, undefined, provenance);
      const outcome = await h.gateway.callToolForGate(
        h.token,
        "provenance-test.write",
        {},
        "dry-run"
      );
      if (outcome.kind !== "declined" || outcome.reason !== "would_confirm") {
        throw new ProtectionFailure("Foreign clean conversation became automatic authority");
      }
      expect(h.calls).not.toHaveBeenCalled();
    };
    await assertForeignRefused(store);
    // Deliberately model removed owner filtering; the separate rollback controls test actual RLS.
    const leaking = {
      isTainted: (_actor: string, threadId: string | undefined) =>
        store.isTainted(ids.userA, threadId),
      recordAdmission: store.recordAdmission.bind(store)
    };
    await expect(assertForeignRefused(leaking)).rejects.toBeInstanceOf(ProtectionFailure);
    await assertForeignRefused(store);
  });

  it("rechecks durable taint after the asynchronous YOLO decision", async () => {
    const a = await create();
    const h = boundGateway(ids.userA, a.id, () =>
      store.recordAdmission(ids.userA, a.id, "attachment_read")
    );
    await expectPending(h);
  });
});
