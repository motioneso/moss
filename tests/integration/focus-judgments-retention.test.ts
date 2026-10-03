import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDatabase, type MossDatabase } from "@moss/db";
import { FocusJudgmentRepository } from "@moss/focus-judgment";
import type { Kysely } from "kysely";
import { deleteUserData } from "../../scripts/delete-user-data.js";
import { exportUserData } from "../../scripts/export-user-data.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2637).
//
// Focus judgments are kept for 30 days. The nightly purge runs as the worker role, which has no
// privilege on the table itself; it can only call the no-argument purge function.

const { Client } = pg;

let workerDb: Kysely<MossDatabase>;
let bootstrap: pg.Client;
let worker: pg.Client;
const repository = new FocusJudgmentRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  worker = new Client({ connectionString: connectionStrings.worker });
  await worker.connect();
});

afterAll(async () => {
  await workerDb.destroy();
  await bootstrap.end();
  await worker.end();
});

beforeEach(async () => {
  await bootstrap.query("DELETE FROM app.focus_judgments");
});

async function insertAged(ownerUserId: string, ageDays: number): Promise<string> {
  const id = randomUUID();
  await bootstrap.query(
    `INSERT INTO app.focus_judgments (id, owner_user_id, block_ref, label, reason, created_at)
     VALUES ($1, $2, 'block-1', 'distracted', 'Unrelated site.', now() - make_interval(days => $3))`,
    [id, ownerUserId, ageDays]
  );
  return id;
}

async function remainingIds(): Promise<string[]> {
  const result = await bootstrap.query<{ id: string }>(
    "SELECT id::text FROM app.focus_judgments ORDER BY id"
  );
  return result.rows.map((row) => row.id);
}

describe("30-day retention purge", () => {
  it("deletes judgments older than 30 days for every person and keeps recent ones", async () => {
    const oldA = await insertAged(ids.userA, 31);
    const oldB = await insertAged(ids.userB, 45);
    const recentA = await insertAged(ids.userA, 1);
    const nearlyExpiredB = await insertAged(ids.userB, 29);

    const purged = await repository.purgeExpired(workerDb);

    expect(purged).toBe(2);
    const remaining = await remainingIds();
    expect(remaining).toEqual([recentA, nearlyExpiredB].sort());
    expect(remaining).not.toContain(oldA);
    expect(remaining).not.toContain(oldB);
  });

  it("the row policy alone keeps recent rows from a definer function with no age filter", async () => {
    const old = await insertAged(ids.userA, 31);
    const recent = await insertAged(ids.userB, 1);

    // Same owner and search path as the real purge, but deleting every row it can see.
    await bootstrap.query(`
      CREATE FUNCTION app.test_unfiltered_focus_purge() RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'app', 'public'
      AS $$
      DECLARE affected integer;
      BEGIN
        DELETE FROM app.focus_judgments;
        GET DIAGNOSTICS affected = ROW_COUNT;
        RETURN affected;
      END;
      $$`);
    try {
      await bootstrap.query(
        "ALTER FUNCTION app.test_unfiltered_focus_purge() OWNER TO jarvis_migration_owner"
      );
      const result = await bootstrap.query<{ count: number }>(
        "SELECT app.test_unfiltered_focus_purge() AS count"
      );
      expect(result.rows[0]?.count).toBe(1);
    } finally {
      await bootstrap.query("DROP FUNCTION app.test_unfiltered_focus_purge()");
    }

    const remaining = await remainingIds();
    expect(remaining).toEqual([recent]);
    expect(remaining).not.toContain(old);
  });

  it("the worker still cannot read or delete the table directly", async () => {
    await insertAged(ids.userA, 31);
    await expect(worker.query("SELECT count(*) FROM app.focus_judgments")).rejects.toThrow(
      /permission denied/i
    );
    await expect(worker.query("DELETE FROM app.focus_judgments")).rejects.toThrow(
      /permission denied/i
    );
    expect(await remainingIds()).toHaveLength(1);
  });
});

describe("user export and deletion", () => {
  it("the export includes the person's own judgments and not another person's", async () => {
    const own = await insertAged(ids.userA, 2);
    const other = await insertAged(ids.userB, 2);

    const userExport = await exportUserData({
      appConnectionString: connectionStrings.app,
      exportedAt: new Date("2026-10-03T12:00:00.000Z"),
      userId: ids.userA
    });

    const exportedIds = userExport.tables.focusJudgments.map((row) => row.id);
    expect(exportedIds).toEqual([own]);
    expect(exportedIds).not.toContain(other);
    expect(userExport.tables.focusJudgments[0]).toEqual(
      expect.objectContaining({
        ownerUserId: ids.userA,
        blockRef: "block-1",
        label: "distracted",
        reason: "Unrelated site."
      })
    );
  });

  it("deleting a person counts and removes their judgments and leaves another person's", async () => {
    await insertAged(ids.userA, 2);
    await insertAged(ids.userA, 40);
    const other = await insertAged(ids.userB, 2);

    const deleted = await deleteUserData({
      actorUserId: ids.userB,
      bootstrapConnectionString: connectionStrings.bootstrap,
      confirmUserId: ids.userA,
      dryRun: false,
      userId: ids.userA
    });

    expect(deleted.countsBeforeDelete["app.focus_judgments"]).toBe(2);
    expect(await remainingIds()).toEqual([other]);
  });
});
