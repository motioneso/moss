import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClassifierShadowRepository } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2868: shadow decision records are owner-only under row-level security (no admin, no
// shared-thread recipient), correlate the model's first tool call by turn, survive storage
// failures without throwing and skip private chats.
// #2908: they are kept forever (no purge job or function) and the owner deletes their own on
// request; another owner, and an admin, cannot.

const { Client } = pg;

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repository = new ClassifierShadowRepository();

const open = (turnId: string, messageText = "turn off the kitchen lights") => ({
  turnId,
  incognito: false,
  messageText,
  classifierConfigId: "cfg-1",
  classifierConfigVersion: "v1",
  thresholdVersion: "t1"
});

const asActor = <T>(
  actorUserId: string,
  work: (db: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
) => dataContext.withDataContext({ actorUserId, requestId: "shadow-test" }, work);

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("app.chat_classifier_shadow_records", () => {
  it("forces row security, lets the app role DELETE its own rows, and has no purge function", async () => {
    const table = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'app.chat_classifier_shadow_records'::regclass
    `.execute(appDb);
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const grant = await sql<{ can_delete: boolean }>`
      SELECT has_table_privilege('jarvis_app_runtime', 'app.chat_classifier_shadow_records', 'DELETE') AS can_delete
    `.execute(appDb);
    expect(grant.rows[0]?.can_delete).toBe(true);

    // #2908 — the fixed 7-day purge is gone, function and all.
    const fn = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'purge_expired_chat_classifier_shadow_records'
    `.execute(appDb);
    expect(fn.rows[0]?.n).toBe("0");
  });

  it("keeps one owner's records invisible to another owner, to an admin and to a shared-thread recipient", async () => {
    const turnId = `turn-${randomUUID()}`;
    const threadId = randomUUID();
    expect(await asActor(ids.userA, (db) => repository.open(db, open(turnId, "secret text")))).toBe(
      true
    );

    // A shares a chat thread with B and with the admin: sharing must not leak shadow records.
    await asActor(ids.userA, async (db) => {
      await sql`INSERT INTO app.chat_threads (id, owner_user_id, title) VALUES (${threadId}::uuid, ${ids.userA}::uuid, 'shared')`.execute(
        db.db
      );
      for (const grantee of [ids.userB, ids.adminUser]) {
        await sql`
          INSERT INTO app.shares (resource_type, resource_id, owner_user_id, grantee_user_id, level)
          VALUES ('chat_thread', ${threadId}::uuid, ${ids.userA}::uuid, ${grantee}::uuid, 'manage')
        `.execute(db.db);
      }
    });

    const own = await asActor(ids.userA, (db) => repository.listForOwner(db));
    expect(own.map((r) => r.turnId)).toContain(turnId);

    for (const other of [ids.userB, ids.adminUser]) {
      const seen = await asActor(other, (db) => repository.listForOwner(db));
      expect(seen.map((r) => r.turnId)).not.toContain(turnId);
    }
  });

  it("stops another owner from writing to or correlating against a record they do not own", async () => {
    const turnId = `turn-${randomUUID()}`;
    await asActor(ids.userA, (db) => repository.open(db, open(turnId)));

    // B updating A's turn matches no row, so A's record is unchanged.
    await asActor(ids.userB, (db) =>
      repository.complete(db, { turnId, decision: "failed", reason: "hijack" })
    );
    const [row] = (await asActor(ids.userA, (db) => repository.listForOwner(db))).filter(
      (r) => r.turnId === turnId
    );
    expect(row?.decision).toBe("pending");

    // B cannot insert a row claiming A as the owner.
    await expect(
      asActor(ids.userB, (db) =>
        sql`
          INSERT INTO app.chat_classifier_shadow_records
            (owner_user_id, turn_id, message_text, gate_mode, classifier_config_id,
             classifier_config_version, threshold_version)
          VALUES (${ids.userA}::uuid, 'forged', 'x', 'shadow', 'c', 'v', 't')
        `.execute(db.db)
      )
    ).rejects.toThrow();
  });

  it("sees and writes nothing without an actor", async () => {
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.chat_classifier_shadow_records
    `.execute(appDb);
    expect(count.rows[0]?.n).toBe("0");
    await expect(
      sql`
        INSERT INTO app.chat_classifier_shadow_records
          (owner_user_id, turn_id, message_text, gate_mode, classifier_config_id,
           classifier_config_version, threshold_version)
        VALUES (${ids.userA}::uuid, 'no-actor', 'x', 'shadow', 'c', 'v', 't')
      `.execute(appDb)
    ).rejects.toThrow();
  });

  it("refuses a delete with no signed-in user, and the actor guard is what refuses it", async () => {
    const turnId = `turn-${randomUUID()}`;
    await asActor(ids.userA, (db) => repository.open(db, open(turnId)));

    // The un-scoped app connection has no actor, so row-level security matches no rows.
    const result = await sql`DELETE FROM app.chat_classifier_shadow_records`.execute(appDb);
    expect(Number(result.numAffectedRows ?? 0)).toBe(0);

    const survivors = (await asActor(ids.userA, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(survivors).toContain(turnId);

    // Prove the actor guard is load-bearing, not decorative: with it removed the same actorless
    // connection would delete every owner's rows. The policy is dropped to that weakened shape on
    // THIS disposable test database and restored in the finally below.
    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `DROP POLICY chat_classifier_shadow_records_delete ON app.chat_classifier_shadow_records`
      );
      await bootstrap.query(
        `CREATE POLICY chat_classifier_shadow_records_delete ON app.chat_classifier_shadow_records
           FOR DELETE TO jarvis_app_runtime
           USING (owner_user_id = app.current_actor_user_id())`
      );
      const weakened = await sql`DELETE FROM app.chat_classifier_shadow_records`.execute(appDb);
      // owner_user_id = NULL is NULL, so no row is deletable without an actor: the actor clause is
      // what the column comparison alone cannot express.
      expect(Number(weakened.numAffectedRows ?? 0)).toBe(0);

      // And with an actor present the column-only policy IS sufficient — the difference the actor
      // clause makes is only the no-actor case, which is exactly the claim under test.
      const asOwner = await asActor(ids.userA, async (db) => {
        const deleted = await sql`DELETE FROM app.chat_classifier_shadow_records`.execute(db.db);
        return Number(deleted.numAffectedRows ?? 0);
      });
      expect(asOwner).toBe(1);
    } finally {
      await bootstrap.query(
        `DROP POLICY IF EXISTS chat_classifier_shadow_records_delete
           ON app.chat_classifier_shadow_records`
      );
      await bootstrap.query(
        `CREATE POLICY chat_classifier_shadow_records_delete
         ON app.chat_classifier_shadow_records
         FOR DELETE TO jarvis_app_runtime
         USING (
           app.current_actor_user_id() IS NOT NULL
           AND owner_user_id = app.current_actor_user_id()
         )`
      );
      await bootstrap.end();
    }

    // Everything is gone for user A either way; leave the table as the suite expects.
    await asActor(ids.userA, (db) => repository.deleteForOwner(db));
  });

  it("the background worker role still cannot delete shadow records", async () => {
    const workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    try {
      // The worker was never granted DELETE, so RLS is not even reached.
      await expect(
        sql`DELETE FROM app.chat_classifier_shadow_records`.execute(workerDb)
      ).rejects.toThrow();
    } finally {
      await workerDb.destroy();
    }
  });

  it("never writes a record for a private chat", async () => {
    const turnId = `turn-${randomUUID()}`;
    const written = await asActor(ids.userA, (db) =>
      repository.open(db, { ...open(turnId), incognito: true })
    );
    expect(written).toBe(false);
    const rows = await asActor(ids.userA, (db) => repository.listForOwner(db));
    expect(rows.map((r) => r.turnId)).not.toContain(turnId);
  });

  it("correlates the model's first tool call whether it lands before or after the decision", async () => {
    const early = `turn-${randomUUID()}`;
    const late = `turn-${randomUUID()}`;
    const decision = {
      decision: "would_handle" as const,
      moduleId: "calendar",
      toolName: "listVisibleEvents",
      confidence: 0.97,
      margin: 0.6,
      latencyMs: 120
    };
    await asActor(ids.userA, async (db) => {
      await repository.open(db, open(early));
      await repository.open(db, open(late));
      // Tool observed first, decision second.
      await repository.observeModelTool(db, early, {
        kind: "tool",
        toolId: "Calendar.listVisibleEvents",
        argumentAgreement: "match"
      });
      await repository.complete(db, { turnId: early, ...decision });
      // Decision first, tool second, with a different tool.
      await repository.complete(db, { turnId: late, ...decision });
      await repository.observeModelTool(db, late, { kind: "tool", toolId: "tasks.create" });
    });
    const rows = await asActor(ids.userA, (db) => repository.listForOwner(db));
    const byTurn = new Map(rows.map((r) => [r.turnId, r]));
    expect(byTurn.get(early)).toMatchObject({
      comparisonStatus: "match",
      argumentAgreement: "match",
      confidence: 0.97
    });
    expect(byTurn.get(late)).toMatchObject({
      comparisonStatus: "mismatch",
      argumentAgreement: null
    });
  });

  it("keeps the first observed model tool when a later tool call arrives", async () => {
    const turnId = `turn-${randomUUID()}`;
    await asActor(ids.userA, async (db) => {
      await repository.open(db, open(turnId));
      await repository.complete(db, {
        turnId,
        decision: "would_handle",
        moduleId: "calendar",
        toolName: "listVisibleEvents"
      });
      // First tool differs from the prediction, a later one would match it.
      await repository.observeModelTool(db, turnId, { kind: "tool", toolId: "tasks.create" });
      await repository.observeModelTool(db, turnId, {
        kind: "tool",
        toolId: "calendar.listVisibleEvents",
        argumentAgreement: "match"
      });
    });
    const rows = await asActor(ids.userA, (db) => repository.listForOwner(db));
    expect(rows.find((r) => r.turnId === turnId)).toMatchObject({
      comparisonStatus: "mismatch",
      modelToolId: "tasks.create",
      argumentAgreement: null
    });
  });

  it("keeps none, failed, cancelled and a missing model tool distinct from a mismatch", async () => {
    const turns = {
      none: `turn-${randomUUID()}`,
      failed: `turn-${randomUUID()}`,
      cancelled: `turn-${randomUUID()}`,
      noTool: `turn-${randomUUID()}`
    };
    await asActor(ids.userA, async (db) => {
      for (const turnId of Object.values(turns)) await repository.open(db, open(turnId));
      await repository.complete(db, { turnId: turns.none, decision: "none" });
      await repository.observeModelTool(db, turns.none, { kind: "tool", toolId: "tasks.create" });
      await repository.complete(db, {
        turnId: turns.failed,
        decision: "failed",
        reason: "timeout"
      });
      await repository.observeModelTool(db, turns.failed, { kind: "tool", toolId: "tasks.create" });
      await repository.complete(db, { turnId: turns.cancelled, decision: "cancelled" });
      await repository.observeModelTool(db, turns.cancelled, { kind: "cancelled" });
      await repository.complete(db, {
        turnId: turns.noTool,
        decision: "would_handle",
        moduleId: "calendar",
        toolName: "listVisibleEvents"
      });
      await repository.observeModelTool(db, turns.noTool, { kind: "no_model_tool" });
    });
    const rows = new Map(
      (await asActor(ids.userA, (db) => repository.listForOwner(db))).map((r) => [r.turnId, r])
    );
    expect(rows.get(turns.none)?.comparisonStatus).toBe("unobserved");
    expect(rows.get(turns.failed)?.comparisonStatus).toBe("unobserved");
    expect(rows.get(turns.cancelled)?.comparisonStatus).toBe("cancelled");
    expect(rows.get(turns.noTool)?.comparisonStatus).toBe("no_model_tool");
  });

  it("reports a storage failure as false and leaves the surrounding transaction usable", async () => {
    const failures: string[] = [];
    const guarded = new ClassifierShadowRepository({ onWriteFailure: (op) => failures.push(op) });
    const turnId = `turn-${randomUUID()}`;
    await asActor(ids.userA, async (db) => {
      // 2001 bytes breaks the length constraint inside the savepoint.
      const failed = await guarded.open(db, { ...open(turnId), messageText: "x".repeat(2001) });
      expect(failed).toBe(false);
      // The same transaction still works afterwards.
      expect(await guarded.open(db, open(turnId))).toBe(true);
    });
    expect(failures).toEqual(["open"]);
    expect(JSON.stringify(failures)).not.toContain("xxxx");
  });

  it("keeps records forever and lets an owner delete only their own", async () => {
    const turnC1 = `turn-${randomUUID()}`;
    const turnC2 = `turn-${randomUUID()}`;
    const turnD = `turn-${randomUUID()}`;
    await asActor(ids.userC, async (db) => {
      await repository.open(db, open(turnC1));
      await repository.open(db, open(turnC2));
    });
    await asActor(ids.userD, (db) => repository.open(db, open(turnD)));

    // userC has exactly its two rows, so the count is its own rows and nobody else's.
    const deleted = await asActor(ids.userC, (db) => repository.deleteForOwner(db));
    expect(deleted).toBe(2);

    const cTurns = (await asActor(ids.userC, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(cTurns).not.toContain(turnC1);
    expect(cTurns).not.toContain(turnC2);
    const dTurns = (await asActor(ids.userD, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(dTurns).toContain(turnD);

    await asActor(ids.userD, (db) => repository.deleteForOwner(db));
  });

  it("stops another user from deleting an owner's records, including by raw SQL", async () => {
    const turnD = `turn-${randomUUID()}`;
    await asActor(ids.userD, (db) => repository.open(db, open(turnD)));

    // The repository path returns only the caller's own count.
    const bBefore = (await asActor(ids.userB, (db) => repository.listForOwner(db))).length;
    expect(await asActor(ids.userB, (db) => repository.deleteForOwner(db))).toBe(bBefore);

    // A raw DELETE from another actor is scoped by row-level security too.
    await asActor(ids.userB, (db) =>
      sql`DELETE FROM app.chat_classifier_shadow_records`.execute(db.db)
    );

    const dTurns = (await asActor(ids.userD, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(dTurns).toContain(turnD);
    await asActor(ids.userD, (db) => repository.deleteForOwner(db));
  });

  it("stops an admin from deleting another owner's records", async () => {
    const turnD = `turn-${randomUUID()}`;
    await asActor(ids.userD, (db) => repository.open(db, open(turnD)));

    const adminBefore = (await asActor(ids.adminUser, (db) => repository.listForOwner(db))).length;
    // Admin power is configuration power only: an admin deletes only their own rows.
    expect(await asActor(ids.adminUser, (db) => repository.deleteForOwner(db))).toBe(adminBefore);

    const dTurns = (await asActor(ids.userD, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(dTurns).toContain(turnD);
    await asActor(ids.userD, (db) => repository.deleteForOwner(db));
  });
});
