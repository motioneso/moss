import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  AiRepository,
  createDbModelActivityRecorder,
  installModelActivityRecorder,
  recordModelActivity
} from "@moss/ai";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * #2956 (slice A): owner-owned activity lines and the owner-only detail table.
 * Rows here are inserted through the repository (the writer call sites land in slice B);
 * this file proves the new RLS shape: each person reads exactly their own lines, admins
 * additionally read ownerless System lines and nothing else, the bare table stays
 * append-only, quoted detail expires after 30 days through the worker-only purge function,
 * and the recording path writes owned rows inside the owner's data context.
 */
describe("activity history storage (#2956)", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;
  let userALineId: string;

  beforeAll(async () => {
    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);

    // User A's chat answer line, with quoted detail.
    userALineId = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.insertModelActivity(scopedDb.db, {
        kind: "chat",
        action: "chat",
        outcome: "ok",
        modelName: "uat-model-alpha",
        result: "completed",
        ownerUserId: ids.userA,
        actionCode: "chat.answer",
        turnId: "uat-turn-a",
        durationMs: 6200,
        factCounts: { tools: 2, jev_agreed: true },
        detail: {
          quote: "Turn on the kitchen light",
          resultLine: "Turned on the kitchen light.",
          steps: [{ title: "Jev guessed which tool to use", result: "Would use Home Assistant" }]
        }
      })
    );

    // User B's structured line, bare only.
    await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      repository.insertModelActivity(scopedDb.db, {
        kind: "structured",
        action: "briefings",
        outcome: "error",
        modelName: "uat-model-beta",
        result: "failed",
        ownerUserId: ids.userB,
        actionCode: "structured.briefings",
        failureCode: "bad_shape"
      })
    );

    // The admin's own line.
    await runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
      repository.insertModelActivity(scopedDb.db, {
        kind: "chat",
        action: "chat",
        outcome: "ok",
        modelName: "uat-model-alpha",
        result: "completed",
        ownerUserId: ids.adminUser,
        actionCode: "chat.answer"
      })
    );

    // A System line: ownerless, 400 days old. Bare lines are kept forever.
    await repository.insertModelActivity(appDb, {
      kind: "chat",
      action: "chat",
      outcome: "ok",
      modelName: "uat-model-alpha",
      result: "completed",
      occurredAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    });
  });

  afterAll(async () => {
    await Promise.allSettled([
      server?.close(),
      appDb?.destroy(),
      workerDb?.destroy(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("extended the bare table with the owner columns and nothing else new", async () => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'moss_model_activity_log'
      ORDER BY column_name
    `.execute(appDb);

    expect(result.rows.map((row) => row.column_name)).toEqual([
      "action",
      "action_code",
      "duration_ms",
      "fact_counts",
      "failure_code",
      "id",
      "input_tokens",
      "kind",
      "model_name",
      "occurred_at",
      "outcome",
      "output_tokens",
      "owner_user_id",
      "parent_id",
      "result",
      "turn_id"
    ]);
  });

  it("shows each person exactly their own lines", async () => {
    const runner = new DataContextRunner(appDb);
    const rowsA = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scopedDb.db.selectFrom("app.moss_model_activity_log").selectAll().execute()
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({
      owner_user_id: ids.userA,
      action_code: "chat.answer",
      turn_id: "uat-turn-a",
      duration_ms: 6200,
      fact_counts: { tools: 2, jev_agreed: true }
    });

    const rowsB = await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      scopedDb.db.selectFrom("app.moss_model_activity_log").selectAll().execute()
    );
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ owner_user_id: ids.userB, failure_code: "bad_shape" });
  });

  it("hides ownerless System lines from a non-admin even with a direct query", async () => {
    const runner = new DataContextRunner(appDb);
    const systemRows = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scopedDb.db
        .selectFrom("app.moss_model_activity_log")
        .selectAll()
        .where("owner_user_id", "is", null)
        .execute()
    );
    expect(systemRows).toHaveLength(0);
  });

  it("shows an admin their own lines plus System lines, and nobody else's", async () => {
    const runner = new DataContextRunner(appDb);
    const rows = await runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
      scopedDb.db
        .selectFrom("app.moss_model_activity_log")
        .selectAll()
        .orderBy("occurred_at", "desc")
        .execute()
    );
    const owners = rows.map((row) => row.owner_user_id);
    expect(owners).toContain(ids.adminUser);
    expect(owners).toContain(null);
    expect(owners).not.toContain(ids.userA);
    expect(owners).not.toContain(ids.userB);
  });

  it("rejects an insert owned by someone else", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        repository.insertModelActivity(scopedDb.db, {
          kind: "chat",
          action: "chat",
          outcome: "ok",
          modelName: "m",
          result: "completed",
          ownerUserId: ids.userB
        })
      )
    ).rejects.toThrow(/permission denied|violates row-level security/i);
  });

  it("keeps the bare table append-only: the app role cannot update or delete a row", async () => {
    const runner = new DataContextRunner(appDb);
    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
        scopedDb.db.updateTable("app.moss_model_activity_log").set({ result: "tampered" }).execute()
      )
    ).rejects.toThrow(/permission denied/i);

    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
        scopedDb.db.deleteFrom("app.moss_model_activity_log").execute()
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it("lets the worker role write ownerless rows but not read the log", async () => {
    const repository = new AiRepository();
    await repository.insertModelActivity(workerDb, {
      kind: "probe",
      action: "worker-write-probe",
      outcome: "ok",
      modelName: "uat-worker-model",
      result: "completed"
    });

    const runner = new DataContextRunner(workerDb);
    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
        scopedDb.db.selectFrom("app.moss_model_activity_log").selectAll().execute()
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it("rejects text and unknown keys in fact_counts, and unknown failure codes", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        repository.insertModelActivity(scopedDb.db, {
          kind: "chat",
          action: "chat",
          outcome: "ok",
          modelName: "m",
          result: "completed",
          ownerUserId: ids.userA,
          factCounts: { note: "words do not belong here" } as never
        })
      )
    ).rejects.toThrow(/check|fact_counts/i);

    // A numeric value under a free-text key is still refused: key names stay on
    // the bare line forever, so only the allow-listed vocabulary may land.
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        repository.insertModelActivity(scopedDb.db, {
          kind: "chat",
          action: "chat",
          outcome: "ok",
          modelName: "m",
          result: "completed",
          ownerUserId: ids.userA,
          factCounts: { tools: 1, leaked_key: 2 }
        })
      )
    ).rejects.toThrow(/allow-list|fact_counts/i);

    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        repository.insertModelActivity(scopedDb.db, {
          kind: "chat",
          action: "chat",
          outcome: "error",
          modelName: "m",
          result: "failed",
          ownerUserId: ids.userA,
          failureCode: "exploded"
        })
      )
    ).rejects.toThrow(/check|failure_code/i);
  });

  it("accepts the images count a judgment with a picture records (#3067)", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);
    // Rolled back after the insert so the row counts the other cases assert stay unchanged.
    const rollback = new Error("rollback");
    let inserted = false;
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, async (scopedDb) => {
        await repository.insertModelActivity(scopedDb.db, {
          kind: "structured",
          action: "choices",
          outcome: "ok",
          modelName: "clef-flash",
          result: "completed",
          ownerUserId: ids.userA,
          factCounts: { confidence: 0.9, images: 1 }
        });
        inserted = true;
        throw rollback;
      })
    ).rejects.toBe(rollback);
    expect(inserted).toBe(true);
  });

  it("refuses a detail row attached to another person's line", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);
    // A bare line of user A's with no detail yet, so a missing refusal cannot
    // hide behind a primary-key collision.
    const bareId = randomUUID();
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      sql`
        INSERT INTO app.moss_model_activity_log
          (id, kind, action, outcome, model_name, result, owner_user_id)
        VALUES (${bareId}, 'chat', 'chat', 'ok', 'uat-model-alpha', 'completed', ${ids.userA})
      `.execute(scopedDb.db)
    );

    // User B plants a detail row on user A's line while claiming B as owner. The
    // owner-sync trigger refuses: B's row-security view cannot see A's line, so
    // the lookup misses and fails closed (a visible mismatch would fail the
    // owner-only INSERT policy instead).
    await expect(
      runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
        sql`INSERT INTO app.moss_activity_detail (activity_id, owner_user_id, steps)
            VALUES (${bareId}, ${ids.userB}, '[]'::jsonb)`.execute(scopedDb.db)
      )
    ).rejects.toThrow(/owned line|row-level security|permission denied/i);

    // Nothing landed.
    const landed = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, bareId)
    );
    expect(landed).toBeUndefined();
  });

  it("refuses moving a detail row onto another person's line", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);
    // User B's bare line with no detail yet.
    const bBareId = randomUUID();
    await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      sql`
        INSERT INTO app.moss_model_activity_log
          (id, kind, action, outcome, model_name, result, owner_user_id)
        VALUES (${bBareId}, 'chat', 'chat', 'ok', 'uat-model-beta', 'completed', ${ids.userB})
      `.execute(scopedDb.db)
    );

    // User A re-parents their own detail row onto B's line. The row policy
    // allows the update (it is A's row), so only the immutability trigger
    // can refuse it.
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        sql`UPDATE app.moss_activity_detail SET activity_id = ${bBareId} WHERE activity_id = ${userALineId}`.execute(
          scopedDb.db
        )
      )
    ).rejects.toThrow(/immutable/i);

    // A's detail still sits on A's line, and B's slot is free: B can write
    // their own detail afterwards.
    const stillA = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, userALineId)
    );
    expect(stillA?.quote).toBe("Turn on the kitchen light");
    await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      sql`INSERT INTO app.moss_activity_detail (activity_id, owner_user_id, steps)
          VALUES (${bBareId}, ${ids.userB}, '[]'::jsonb)`.execute(scopedDb.db)
    );
  });

  it("refuses a detail row on an ownerless System line", async () => {
    const runner = new DataContextRunner(appDb);
    const systemRows = await runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
      scopedDb.db
        .selectFrom("app.moss_model_activity_log")
        .select("id")
        .where("owner_user_id", "is", null)
        .execute()
    );
    expect(systemRows.length).toBeGreaterThan(0);
    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
        sql`INSERT INTO app.moss_activity_detail (activity_id, owner_user_id, steps)
            VALUES (${systemRows[0]!.id}, ${ids.adminUser}, '[]'::jsonb)`.execute(scopedDb.db)
      )
    ).rejects.toThrow(/ownerless/i);
  });

  it("refuses a detail insert that outlives the 30-day retention", async () => {
    const runner = new DataContextRunner(appDb);
    const farId = randomUUID();
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      sql`
        INSERT INTO app.moss_model_activity_log
          (id, kind, action, outcome, model_name, result, owner_user_id)
        VALUES (${farId}, 'chat', 'chat', 'ok', 'uat-model-alpha', 'completed', ${ids.userA})
      `.execute(scopedDb.db)
    );
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        sql`
          INSERT INTO app.moss_activity_detail
            (activity_id, owner_user_id, steps, expires_at)
          VALUES (${farId}, ${ids.userA}, '[]'::jsonb, now() + interval '60 days')
        `.execute(scopedDb.db)
      )
    ).rejects.toThrow(/30 days/i);
  });

  it("refuses a detail insert that dates creation in the future", async () => {
    const runner = new DataContextRunner(appDb);
    const futureId = randomUUID();
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      sql`
        INSERT INTO app.moss_model_activity_log
          (id, kind, action, outcome, model_name, result, owner_user_id)
        VALUES (${futureId}, 'chat', 'chat', 'ok', 'uat-model-alpha', 'completed', ${ids.userA})
      `.execute(scopedDb.db)
    );
    // Creation in 2099 with expiry 30 days after that would never purge: the
    // trigger forces creation to now(), so the far-future expiry then fails
    // the 30-day cap instead of keeping the quoted words for decades.
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        sql`
          INSERT INTO app.moss_activity_detail
            (activity_id, owner_user_id, steps, created_at, expires_at)
          VALUES (
            ${futureId}, ${ids.userA}, '[]'::jsonb,
            '2099-01-01T00:00:00Z', '2099-01-31T00:00:00Z'
          )
        `.execute(scopedDb.db)
      )
    ).rejects.toThrow(/30 days|creation/i);
  });

  it("keeps detail owner-only: others cannot read or change it", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);

    const seenByB = await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, userALineId)
    );
    expect(seenByB).toBeUndefined();

    const seenByA = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, userALineId)
    );
    expect(seenByA).toMatchObject({
      owner_user_id: ids.userA,
      quote: "Turn on the kitchen light"
    });

    // Another person's update touches zero rows: the policy filters before the trigger.
    await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      repository.attachModelActivityFacts(scopedDb, userALineId, { quote: "rewritten" })
    );
    const stillA = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, userALineId)
    );
    expect(stillA?.quote).toBe("Turn on the kitchen light");

    // The owner can attach a late fact, but not move the row or its expiry.
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.attachModelActivityFacts(scopedDb, userALineId, {
        resultLine: "Turned on the kitchen light. Jev agreed."
      })
    );
    const updated = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, userALineId)
    );
    expect(updated?.result_line).toBe("Turned on the kitchen light. Jev agreed.");

    // Even the owner cannot move the row: the immutability trigger fires past RLS.
    await expect(
      runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
        sql`UPDATE app.moss_activity_detail SET owner_user_id = ${ids.userB} WHERE activity_id = ${userALineId}`.execute(
          scopedDb.db
        )
      )
    ).rejects.toThrow(/immutable/i);
  });

  it("hides expired detail from reads and purges it through the worker-only function", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);

    // An expired fixture, inserted directly with a past expiry: the trigger forbids
    // backdating through UPDATE, and the INSERT policies do not constrain expiry.
    const expiredId = randomUUID();
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      (async () => {
        await sql`
          INSERT INTO app.moss_model_activity_log
            (id, kind, action, outcome, model_name, result, owner_user_id)
          VALUES (${expiredId}, 'chat', 'chat', 'ok', 'uat-model-alpha', 'completed', ${ids.userA})
        `.execute(scopedDb.db);
        await sql`
          INSERT INTO app.moss_activity_detail
            (activity_id, owner_user_id, quote, steps, expires_at)
          VALUES (${expiredId}, ${ids.userA}, 'already expired', '[]'::jsonb, now() - interval '1 day')
        `.execute(scopedDb.db);
      })()
    );

    const hidden = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.getModelActivityDetail(scopedDb, expiredId)
    );
    expect(hidden).toBeUndefined();

    // The app role cannot call the purge function; the worker role can.
    await expect(
      sql`SELECT app.purge_expired_moss_activity_detail()`.execute(appDb)
    ).rejects.toThrow(/permission denied/i);

    const purged = await repository.purgeExpiredActivityDetail(workerDb);
    expect(purged).toBeGreaterThanOrEqual(1);

    const remaining = await sql<{ count: string }>`
      SELECT count(*) FROM app.moss_activity_detail WHERE activity_id = ${expiredId}
    `.execute(appDb);
    expect(Number(remaining.rows[0]?.count ?? 1)).toBe(0);

    // The bare line survives expiry: only the quoted words go.
    const bare = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scopedDb.db
        .selectFrom("app.moss_model_activity_log")
        .selectAll()
        .where("id", "=", expiredId)
        .executeTakeFirst()
    );
    expect(bare).toBeDefined();
  });

  it("records an owned entry inside the owner's data context, like the install sites do", async () => {
    const repository = new AiRepository();
    const runner = new DataContextRunner(appDb);
    // Same routing the API and worker install sites use: owned entries write inside the
    // owner's data context, ownerless entries on the root handle.
    const productionShapedRecorder = createDbModelActivityRecorder(async (entry) => {
      if (entry.ownerUserId) {
        await runner.withDataContext({ actorUserId: entry.ownerUserId }, (scopedDb) =>
          repository.insertModelActivity(scopedDb.db, entry)
        );
      } else {
        await repository.insertModelActivity(appDb, entry);
      }
    });
    try {
      installModelActivityRecorder(productionShapedRecorder);
      recordModelActivity({
        kind: "chat",
        action: "recorder-owner-probe",
        outcome: "ok",
        modelName: "uat-recorder-probe-model",
        result: "completed",
        ownerUserId: ids.userB,
        actionCode: "chat.answer",
        turnId: "uat-turn-recorder-probe",
        detail: { quote: "through the recorder" }
      });

      let found: { id: string; turn_id: string | null } | undefined;
      for (let attempt = 0; attempt < 40 && !found; attempt++) {
        found = await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
          scopedDb.db
            .selectFrom("app.moss_model_activity_log")
            .select(["id", "turn_id"])
            .where("model_name", "=", "uat-recorder-probe-model")
            .executeTakeFirst()
        );
        if (!found) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(found).toBeDefined();
      // The turn id set at turn start survives the fire-and-forget write.
      expect(found!.turn_id).toBe("uat-turn-recorder-probe");
      const detail = await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
        repository.getModelActivityDetail(scopedDb, found!.id)
      );
      expect(detail?.quote).toBe("through the recorder");
    } finally {
      // Leave the process-wide recorder as the API installed it, for the probe test below.
      installModelActivityRecorder(productionShapedRecorder);
    }
  });

  // #2956 (slice D): the old admin-only /api/ai/model-activity endpoint retired with
  // its page. Endpoint-level admin coverage lives on /api/ai/activity-lines in
  // activity-lines.test.ts; this file keeps the row-security proofs below.

  it("installs the recorder at API startup so a production record call writes a row", async () => {
    recordModelActivity({
      kind: "chat",
      action: "recorder-install-probe",
      outcome: "ok",
      modelName: "uat-recorder-probe-model",
      result: "completed"
    });

    const runner = new DataContextRunner(appDb);
    let found: { id: string } | undefined;
    for (let attempt = 0; attempt < 40 && !found; attempt++) {
      found = await runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
        scopedDb.db
          .selectFrom("app.moss_model_activity_log")
          .select("id")
          .where("model_name", "=", "uat-recorder-probe-model")
          .executeTakeFirst()
      );
      if (!found) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(found).toBeDefined();
  });
});
