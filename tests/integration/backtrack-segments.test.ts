import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql, type Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  backtrackModuleManifest,
  BacktrackRepository,
  type NewBacktrackSegmentInput
} from "@moss/backtrack";
import { createActiveModulesResolver, getModuleDeletionTables } from "@moss/module-registry";
import { SettingsRepository } from "../../packages/settings/src/repository.js";
import { deleteUserData } from "../../scripts/delete-user-data.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Needs a database: run through the verify-gate skill, scoped to this file (#2638 plan §4.2).

const { Client } = pg;

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let bootstrap: pg.Client;
let worker: pg.Client;
const repository = new BacktrackRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  worker = new Client({ connectionString: connectionStrings.worker });
  await worker.connect();
});

afterAll(async () => {
  await appDb.destroy();
  await workerDb.destroy();
  await bootstrap.end();
  await worker.end();
});

function bodyHash(): Buffer {
  return randomBytes(32);
}

function baseSegment(overrides: Partial<NewBacktrackSegmentInput> = {}): NewBacktrackSegmentInput {
  const now = new Date();
  return {
    deviceId: randomUUID(),
    startedAt: now,
    endedAt: now,
    appName: "Safari",
    bundleId: "com.apple.Safari",
    windowTitle: "Example",
    address: "https://example.test",
    body: "example body",
    bodyHash: bodyHash(),
    clientStartedAt: now,
    ...overrides
  };
}

async function insertUser(email: string): Promise<string> {
  const id = randomUUID();
  await bootstrap.query(
    `INSERT INTO app.users (id, email, is_instance_admin) VALUES ($1, $2, false)`,
    [id, email]
  );
  return id;
}

async function segmentIdsFor(ownerUserId: string): Promise<string[]> {
  const result = await bootstrap.query<{ id: string }>(
    `SELECT id::text FROM app.backtrack_segments WHERE owner_user_id = $1`,
    [ownerUserId]
  );
  return result.rows.map((row) => row.id);
}

describe("app.backtrack_segments CHECK constraints", () => {
  const owner = ids.userA;

  async function insertRaw(fields: Record<string, unknown>): Promise<unknown> {
    const merged = {
      owner_user_id: owner,
      device_id: randomUUID(),
      started_at: new Date(),
      ended_at: new Date(),
      app_name: "Safari",
      bundle_id: "com.apple.Safari",
      window_title: "Example",
      address: null,
      body: "body",
      body_hash: bodyHash(),
      client_started_at: new Date(),
      ...fields
    };
    const columns = Object.keys(merged);
    const values = Object.values(merged);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    return bootstrap.query(
      `INSERT INTO app.backtrack_segments (${columns.join(", ")}) VALUES (${placeholders})`,
      values
    );
  }

  it("accepts a multibyte body of exactly 8192 bytes", async () => {
    // "é" is 2 UTF-8 bytes, so 4096 of them is exactly 8192 bytes but only 4096 characters —
    // this fails if the check counts characters instead of octet_length.
    const body = "é".repeat(4096);
    await expect(insertRaw({ body })).resolves.toBeDefined();
  });

  it("rejects a multibyte body of 8193 bytes", async () => {
    const body = `${"é".repeat(4096)}x`;
    await expect(insertRaw({ body })).rejects.toThrow(/violates check constraint/i);
  });

  it("rejects ended_at before started_at", async () => {
    const started = new Date();
    const ended = new Date(started.getTime() - 1000);
    await expect(insertRaw({ started_at: started, ended_at: ended })).rejects.toThrow(
      /violates check constraint/i
    );
  });
});

describe("BacktrackRepository.insertSegments idempotency", () => {
  it("storing the same batch twice keeps one copy", async () => {
    const owner = ids.userA;
    const runner = new DataContextRunner(appDb);
    const segment = baseSegment();

    const firstIds = await runner.withDataContext(
      { actorUserId: owner, requestId: "test:backtrack-dup-1" },
      (scopedDb) => repository.insertSegments(scopedDb, owner, [segment])
    );
    expect(firstIds).toHaveLength(1);

    const secondIds = await runner.withDataContext(
      { actorUserId: owner, requestId: "test:backtrack-dup-2" },
      (scopedDb) => repository.insertSegments(scopedDb, owner, [segment])
    );
    expect(secondIds).toHaveLength(0);

    const rows = await bootstrap.query(
      `SELECT count(*)::int AS n FROM app.backtrack_segments
       WHERE owner_user_id = $1 AND device_id = $2 AND client_started_at = $3`,
      [owner, segment.deviceId, segment.clientStartedAt]
    );
    expect(rows.rows[0]?.n).toBe(1);
  });
});

describe("cross-owner isolation", () => {
  it("SELECT and DELETE see nothing of another owner, as jarvis_app_runtime and jarvis_worker_runtime", async () => {
    const owner = ids.userB;
    const otherActor = ids.userA;
    const segment = baseSegment();
    const [ownerSegmentId] = await new DataContextRunner(appDb).withDataContext(
      { actorUserId: owner, requestId: "test:backtrack-cross-owner-arrange" },
      (scopedDb) => repository.insertSegments(scopedDb, owner, [segment])
    );
    expect(ownerSegmentId).toBeDefined();

    for (const [label, db] of [
      ["app", appDb],
      ["worker", workerDb]
    ] as const) {
      const runner = new DataContextRunner(db);
      await runner.withDataContext(
        { actorUserId: otherActor, requestId: `test:backtrack-cross-owner-${label}` },
        async (scopedDb) => {
          const selected = await repository.selectSegmentsByIds(scopedDb, owner, [ownerSegmentId!]);
          expect(selected).toEqual([]);

          const plain = await sql<{ id: string }>`
            SELECT id FROM app.backtrack_segments WHERE id = ${ownerSegmentId}
          `.execute(scopedDb.db);
          expect(plain.rows).toEqual([]);

          const deleted = await repository.deleteSegmentsInRange(scopedDb, owner, {
            from: null,
            to: null
          });
          expect(deleted).toEqual([]);
        }
      );
    }

    const stillThere = await bootstrap.query(
      `SELECT id FROM app.backtrack_segments WHERE id = $1`,
      [ownerSegmentId]
    );
    expect(stillThere.rows).toHaveLength(1);
  });
});

describe("worker write restrictions", () => {
  it("the worker cannot INSERT a segment", async () => {
    await expect(
      worker.query(
        `INSERT INTO app.backtrack_segments
           (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title,
            body, body_hash, client_started_at)
         VALUES ($1, $2, now(), now(), 'Safari', 'com.apple.Safari', 'x', 'y', $3, now())`,
        [ids.userA, randomUUID(), bodyHash()]
      )
    ).rejects.toThrow(/permission denied/i);
  });

  it("the worker cannot UPDATE any column except indexed_at", async () => {
    const owner = ids.userA;
    const [segmentId] = await new DataContextRunner(appDb).withDataContext(
      { actorUserId: owner, requestId: "test:backtrack-worker-update-arrange" },
      (scopedDb) => repository.insertSegments(scopedDb, owner, [baseSegment()])
    );
    expect(segmentId).toBeDefined();

    await expect(
      worker.query(`UPDATE app.backtrack_segments SET body = 'changed' WHERE id = $1`, [segmentId])
    ).rejects.toThrow(/permission denied/i);

    const updated = await new DataContextRunner(workerDb).withDataContext(
      { actorUserId: owner, requestId: "test:backtrack-worker-update-indexed-at" },
      (scopedDb) =>
        sql<{ id: string }>`
          UPDATE app.backtrack_segments SET indexed_at = now() WHERE id = ${segmentId} RETURNING id
        `.execute(scopedDb.db)
    );
    expect(updated.rows).toEqual([{ id: segmentId }]);
  });
});

describe("app.backtrack_owners_needing_upkeep()", () => {
  it("returns exactly the owners with a qualifying row, and nobody else, as the worker with no actor set", async () => {
    const expiredByStartedAt = await insertUser("backtrack-upkeep-started@example.test");
    const expiredByCreatedAt = await insertUser("backtrack-upkeep-created@example.test");
    const staleUnindexed = await insertUser("backtrack-upkeep-stale@example.test");
    const oldMarkerOwner = await insertUser("backtrack-upkeep-marker@example.test");
    const freshOwner = await insertUser("backtrack-upkeep-fresh@example.test");
    const freshMarkerOwner = await insertUser("backtrack-upkeep-fresh-marker@example.test");

    async function insertSegmentRaw(
      ownerUserId: string,
      overrides: Record<string, unknown>
    ): Promise<void> {
      const now = new Date();
      const merged = {
        owner_user_id: ownerUserId,
        device_id: randomUUID(),
        started_at: now,
        ended_at: now,
        app_name: "Safari",
        bundle_id: "com.apple.Safari",
        window_title: "x",
        body: "y",
        body_hash: bodyHash(),
        client_started_at: now,
        created_at: now,
        indexed_at: now,
        ...overrides
      };
      const columns = Object.keys(merged);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      await bootstrap.query(
        `INSERT INTO app.backtrack_segments (${columns.join(", ")}) VALUES (${placeholders})`,
        Object.values(merged)
      );
    }

    const d = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    await insertSegmentRaw(expiredByStartedAt, { started_at: d(40), ended_at: d(40) });
    await insertSegmentRaw(expiredByCreatedAt, { started_at: new Date(), created_at: d(40) });
    await insertSegmentRaw(staleUnindexed, { created_at: d(0.02), indexed_at: null }); // ~29 min ago
    await insertSegmentRaw(freshOwner, {});

    await bootstrap.query(
      `INSERT INTO app.backtrack_deletions (owner_user_id, range, created_at)
       VALUES ($1, tstzrange(null, now(), '[)'), $2)`,
      [oldMarkerOwner, d(39)]
    );
    await bootstrap.query(
      `INSERT INTO app.backtrack_deletions (owner_user_id, range, created_at)
       VALUES ($1, tstzrange(null, now(), '[)'), $2)`,
      [freshMarkerOwner, d(1)]
    );

    const result = await worker.query<{ owner_user_id: string }>(
      `SELECT owner_user_id::text FROM app.backtrack_owners_needing_upkeep()`
    );
    const owners = result.rows.map((row) => row.owner_user_id).sort();

    expect(owners).toEqual(
      [expiredByStartedAt, expiredByCreatedAt, staleUnindexed, oldMarkerOwner].sort()
    );
    expect(owners).not.toContain(freshOwner);
    expect(owners).not.toContain(freshMarkerOwner);

    // Same no-actor worker connection, a plain SELECT on the table returns nothing.
    const plain = await worker.query(`SELECT id FROM app.backtrack_segments`);
    expect(plain.rows).toEqual([]);
  });

  it("returns nothing (the S1 failure) without the maintenance policies, and the right owners once they exist", async () => {
    const owner = await insertUser("backtrack-upkeep-s1@example.test");
    const d40 = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await bootstrap.query(
      `INSERT INTO app.backtrack_segments
         (owner_user_id, device_id, started_at, ended_at, app_name, bundle_id, window_title,
          body, body_hash, client_started_at)
       VALUES ($1, $2, $3, $3, 'Safari', 'com.apple.Safari', 'x', 'y', $4, $3)`,
      [owner, randomUUID(), d40, bodyHash()]
    );

    await bootstrap.query(`DROP POLICY backtrack_segments_upkeep_select ON app.backtrack_segments`);
    await bootstrap.query(
      `DROP POLICY backtrack_deletions_upkeep_select ON app.backtrack_deletions`
    );
    try {
      const broken = await worker.query<{ owner_user_id: string }>(
        `SELECT owner_user_id::text FROM app.backtrack_owners_needing_upkeep()`
      );
      expect(broken.rows.map((row) => row.owner_user_id)).not.toContain(owner);
    } finally {
      await bootstrap.query(`
        CREATE POLICY backtrack_segments_upkeep_select ON app.backtrack_segments
          FOR SELECT TO jarvis_migration_owner
          USING (
            started_at < now() - interval '37 days'
            OR created_at < now() - interval '37 days'
            OR (indexed_at IS NULL AND created_at < now() - interval '10 minutes')
          )
      `);
      await bootstrap.query(`
        CREATE POLICY backtrack_deletions_upkeep_select ON app.backtrack_deletions
          FOR SELECT TO jarvis_migration_owner
          USING (created_at < now() - interval '38 days')
      `);
    }

    const fixed = await worker.query<{ owner_user_id: string }>(
      `SELECT owner_user_id::text FROM app.backtrack_owners_needing_upkeep()`
    );
    expect(fixed.rows.map((row) => row.owner_user_id)).toContain(owner);
  });

  it("is a STABLE SECURITY DEFINER function owned by the migration owner, with a pinned search path", async () => {
    const result = await bootstrap.query<{ owner: string; definer: boolean; config: string[] }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
       FROM pg_proc p
       WHERE p.oid = 'app.backtrack_owners_needing_upkeep()'::regprocedure`
    );
    expect(result.rows).toEqual([
      { owner: "jarvis_migration_owner", definer: true, config: ["search_path=pg_catalog, app"] }
    ]);
  });
});

describe("the module cannot be disabled", () => {
  it("the instance and user enablement resolvers both still report backtrack enabled", async () => {
    const runner = new DataContextRunner(appDb);
    const settingsRepository = new SettingsRepository();
    const resolver = createActiveModulesResolver({
      dataContext: runner,
      manifests: () => [backtrackModuleManifest]
    });

    await runner.withDataContext(
      { actorUserId: ids.adminUser, requestId: "test:backtrack-non-disableable-instance" },
      (db) =>
        settingsRepository.setInstanceModuleDisabled(db, {
          moduleId: "backtrack",
          disabled: true,
          actorUserId: ids.adminUser,
          requestId: "test:backtrack-non-disableable-instance"
        })
    );
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "test:backtrack-non-disableable-user" },
      (db) =>
        settingsRepository.setUserModuleDisabled(db, {
          moduleId: "backtrack",
          disabled: true,
          actorUserId: ids.userA,
          requestId: "test:backtrack-non-disableable-user"
        })
    );

    try {
      expect((await resolver(ids.userA)).map((m) => m.id)).toContain("backtrack");
      expect((await resolver(ids.userB)).map((m) => m.id)).toContain("backtrack");
    } finally {
      await runner.withDataContext(
        {
          actorUserId: ids.adminUser,
          requestId: "test:backtrack-non-disableable-cleanup-instance"
        },
        (db) =>
          settingsRepository.setInstanceModuleDisabled(db, {
            moduleId: "backtrack",
            disabled: false,
            actorUserId: ids.adminUser,
            requestId: "test:backtrack-non-disableable-cleanup-instance"
          })
      );
      await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "test:backtrack-non-disableable-cleanup-user" },
        (db) =>
          settingsRepository.setUserModuleDisabled(db, {
            moduleId: "backtrack",
            disabled: false,
            actorUserId: ids.userA,
            requestId: "test:backtrack-non-disableable-cleanup-user"
          })
      );
    }
  });
});

describe("account deletion", () => {
  it("removes the user's segments, preferences, deletion markers and screen chunks, and leaves another owner's", async () => {
    const owner = await insertUser("backtrack-deletion-target@example.test");
    const other = await insertUser("backtrack-deletion-other@example.test");
    const runner = new DataContextRunner(appDb);

    await runner.withDataContext(
      { actorUserId: owner, requestId: "test:backtrack-deletion-arrange-owner" },
      async (scopedDb) => {
        await repository.insertSegments(scopedDb, owner, [baseSegment()]);
        await repository.setPaused(scopedDb, owner, true);
        await repository.insertDeletionMarker(scopedDb, owner, null, new Date());
      }
    );
    await runner.withDataContext(
      { actorUserId: other, requestId: "test:backtrack-deletion-arrange-other" },
      async (scopedDb) => {
        await repository.insertSegments(scopedDb, other, [baseSegment()]);
        await repository.setPaused(scopedDb, other, true);
      }
    );

    const [ownerSegmentId] = await segmentIdsFor(owner);
    await bootstrap.query(
      `INSERT INTO app.memory_chunks
         (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
       VALUES ($1, 'screen', $2, 0, 0, 'hash', 'owner screen text')`,
      [owner, `backtrack/${ownerSegmentId}`]
    );
    const [otherSegmentId] = await segmentIdsFor(other);
    await bootstrap.query(
      `INSERT INTO app.memory_chunks
         (owner_user_id, source_kind, source_path, line_start, line_end, content_hash, text)
       VALUES ($1, 'screen', $2, 0, 0, 'hash', 'other screen text')`,
      [other, `backtrack/${otherSegmentId}`]
    );

    const deleted = await deleteUserData({
      actorUserId: other,
      bootstrapConnectionString: connectionStrings.bootstrap,
      confirmUserId: owner,
      dryRun: false,
      userId: owner,
      moduleDeletionTables: getModuleDeletionTables()
    });

    expect(deleted.countsBeforeDelete["app.backtrack_segments"]).toBe(1);
    expect(deleted.countsBeforeDelete["app.backtrack_preferences"]).toBe(1);
    expect(deleted.countsBeforeDelete["app.backtrack_deletions"]).toBe(1);

    // Scope every "what's left" check to the two actors this test created — the file's other
    // describe blocks (CHECK constraints, idempotency, cross-owner isolation, the upkeep
    // function, ...) all write their own rows into these same tables and never clean up, so an
    // unscoped SELECT here also sees their leftovers.
    const bothOwners = [owner, other];

    const remainingSegments = await bootstrap.query(
      `SELECT owner_user_id::text AS owner FROM app.backtrack_segments
       WHERE owner_user_id = ANY($1::uuid[])`,
      [bothOwners]
    );
    expect(remainingSegments.rows.map((row) => row.owner)).toEqual([other]);

    const remainingPreferences = await bootstrap.query(
      `SELECT owner_user_id::text AS owner FROM app.backtrack_preferences
       WHERE owner_user_id = ANY($1::uuid[])`,
      [bothOwners]
    );
    expect(remainingPreferences.rows.map((row) => row.owner)).toEqual([other]);

    const remainingDeletions = await bootstrap.query(
      `SELECT owner_user_id::text AS owner FROM app.backtrack_deletions
       WHERE owner_user_id = ANY($1::uuid[])`,
      [bothOwners]
    );
    expect(remainingDeletions.rows).toEqual([]);

    const remainingScreenChunks = await bootstrap.query<{ owner: string }>(
      `SELECT owner_user_id::text AS owner FROM app.memory_chunks
       WHERE source_kind = 'screen' AND owner_user_id = ANY($1::uuid[])`,
      [bothOwners]
    );
    expect(remainingScreenChunks.rows.map((row) => row.owner)).toEqual([other]);
  });
});
