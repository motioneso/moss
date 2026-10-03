import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { FocusJudgmentRepository } from "@moss/focus-judgment";
import type { Job } from "@moss/jobs";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { readVaultFile, VaultContextRunner } from "@moss/vault";
import type { Kysely } from "kysely";
import {
  handleExportBuildJob,
  type ExportBuildJobPayload
} from "../../packages/settings/src/data-export-jobs.js";
import { DataExportRepository } from "../../packages/settings/src/data-export-repository.js";
import { deleteUserData } from "../../scripts/delete-user-data.js";
import { exportUserData } from "../../scripts/export-user-data.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2637).
//
// Focus judgments are kept for 30 days. The nightly purge runs as the worker role, which may read
// only the current actor's rows (for the export build job) and deletes only through the
// no-argument purge function.

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

  it("the purge function is owned by the migration owner, a definer, with a pinned search path", async () => {
    const result = await bootstrap.query<{ owner: string; definer: boolean; config: string[] }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
       FROM pg_proc p
       WHERE p.oid = 'app.purge_expired_focus_judgments()'::regprocedure`
    );
    expect(result.rows).toEqual([
      { owner: "jarvis_migration_owner", definer: true, config: ["search_path=app, public"] }
    ]);
  });

  it("only the worker may run the purge", async () => {
    for (const connectionString of [connectionStrings.app, connectionStrings.auth]) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        // Refused at the function, not later at the table.
        await expect(client.query("SELECT app.purge_expired_focus_judgments()")).rejects.toThrow(
          /permission denied for function purge_expired_focus_judgments/i
        );
      } finally {
        await client.end();
      }
    }
  });

  it("the worker reads only the current person's judgments and can never delete them", async () => {
    const ownA = await insertAged(ids.userA, 2);
    await insertAged(ids.userB, 2);

    // No actor set: the worker read rule matches nothing.
    const unscoped = await worker.query("SELECT id FROM app.focus_judgments");
    expect(unscoped.rows).toEqual([]);

    // Actor set, as the export build job runs: only that person's rows.
    const scoped = await new DataContextRunner(workerDb).withDataContext(
      { actorUserId: ids.userA, requestId: "req:test" },
      (scopedDb) => scopedDb.db.selectFrom("app.focus_judgments").select("id").execute()
    );
    expect(scoped.map((row) => row.id)).toEqual([ownA]);

    await expect(worker.query("DELETE FROM app.focus_judgments")).rejects.toThrow(
      /permission denied/i
    );
    expect(await remainingIds()).toHaveLength(2);
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

  it("the Settings export download carries the person's own judgments and not another person's", async () => {
    const own = await insertAged(ids.userA, 2);
    const other = await insertAged(ids.userB, 2);

    const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-focus-"));
    const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
    process.env.JARVIS_VAULT_ROOT = vaultRoot;
    try {
      const context = { actorUserId: ids.userA, requestId: "req:test" };
      const jobRecord = await new DataContextRunner(appDb).withDataContext(context, (scopedDb) =>
        new DataExportRepository().createJob(scopedDb, ids.userA)
      );

      // The Settings "Export data" button builds the archive in this worker job.
      await new DataContextRunner(workerDb).withDataContext(context, (scopedDb) =>
        handleExportBuildJob(
          {
            data: { actorUserId: ids.userA, jobId: jobRecord.id, kind: "export.build" }
          } as Job<ExportBuildJobPayload>,
          scopedDb,
          () => getBuiltInModuleManifests()
        )
      );

      const archiveJson = await new VaultContextRunner(vaultRoot).withVaultContext(
        { actorUserId: ids.userA },
        (vaultCtx) => readVaultFile(vaultCtx, `exports/${jobRecord.id}.json`)
      );
      const archive = JSON.parse(archiveJson) as {
        sections: { focus_judgments: Array<{ id: string }> };
      };

      expect(archive.sections.focus_judgments.map((row) => row.id)).toEqual([own]);
      expect(archiveJson).not.toContain(other);
    } finally {
      if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
      else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
      await rm(vaultRoot, { recursive: true, force: true });
      await appDb.destroy();
    }
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
