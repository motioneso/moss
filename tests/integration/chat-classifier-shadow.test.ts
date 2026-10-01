import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClassifierShadowRepository } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2868: shadow decision records are owner-only under row-level security (no admin, no
// shared-thread recipient), correlate the model's first tool call by turn, survive storage
// failures without throwing, skip private chats, and expire after a fixed 7 days.

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
  it("forces row security and gives the app role no DELETE", async () => {
    const table = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'app.chat_classifier_shadow_records'::regclass
    `.execute(appDb);
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const grant = await sql<{ can_delete: boolean }>`
      SELECT has_table_privilege('jarvis_app_runtime', 'app.chat_classifier_shadow_records', 'DELETE') AS can_delete
    `.execute(appDb);
    expect(grant.rows[0]?.can_delete).toBe(false);
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

  it("purges only records older than 7 days, for every owner, over the worker role", async () => {
    const expiredA = `turn-${randomUUID()}`;
    const recentA = `turn-${randomUUID()}`;
    const expiredB = `turn-${randomUUID()}`;
    const sixDaysA = `turn-${randomUUID()}`;
    await asActor(ids.userA, async (db) => {
      await repository.open(db, open(expiredA));
      await repository.open(db, open(recentA));
      await repository.open(db, open(sixDaysA));
    });
    await asActor(ids.userB, (db) => repository.open(db, open(expiredB)));

    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `UPDATE app.chat_classifier_shadow_records
         SET created_at = now() - interval '8 days' WHERE turn_id = ANY($1)`,
        [[expiredA, expiredB]]
      );
      await bootstrap.query(
        `UPDATE app.chat_classifier_shadow_records
         SET created_at = now() - interval '6 days' WHERE turn_id = $1`,
        [sixDaysA]
      );
    } finally {
      await bootstrap.end();
    }

    const workerDb = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    try {
      expect(await repository.purgeExpired(workerDb)).toBeGreaterThanOrEqual(2);
      // The worker has no way to run a wider delete directly.
      await expect(
        sql`DELETE FROM app.chat_classifier_shadow_records`.execute(workerDb)
      ).rejects.toThrow();
    } finally {
      await workerDb.destroy();
    }

    const remainingA = (await asActor(ids.userA, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(remainingA).toContain(recentA);
    expect(remainingA).toContain(sixDaysA);
    expect(remainingA).not.toContain(expiredA);
    const remainingB = (await asActor(ids.userB, (db) => repository.listForOwner(db))).map(
      (r) => r.turnId
    );
    expect(remainingB).not.toContain(expiredB);
  });
});
