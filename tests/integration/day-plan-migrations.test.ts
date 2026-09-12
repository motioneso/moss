import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, runSqlMigrations } from "@moss/db";
import { DayPlanRepository } from "@moss/calendar";

import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

const files = [
  "0229_day_plans.sql",
  "0229a_day_plan_preserve_legacy.sql",
  "0230_day_plan_ownership.sql",
  "0231_day_plan_reconcile_storage.sql",
  "0232_day_plan_blank_legacy_notes.sql"
];
const versions = ["0229", "0229a", "0230", "0231", "0232"];
const { Client } = pg;

describe("day-plan migration live acceptance", () => {
  let bootstrap: pg.Client;
  let directory: string;

  beforeEach(async () => {
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    await resetFoundationDatabase();
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    directory = await mkdtemp(join(tmpdir(), "day-plan-migrations-"));
  });

  afterEach(async () => {
    await bootstrap?.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function copyMigrations(names: readonly string[]) {
    for (const name of names) {
      await copyFile(join(process.cwd(), "packages/calendar/sql", name), join(directory, name));
    }
  }

  function migrate() {
    return runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: directory
    });
  }

  async function baseline(names: readonly string[]) {
    // Like the existing Sports upgrade tests: rewind only this feature inside
    // the guarded disposable database. Never change checked-in migration files.
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    await bootstrap.query(
      "DROP TABLE app.day_plan_operations, app.day_plan_blocks, app.day_plans CASCADE"
    );
    await bootstrap.query("DROP FUNCTION IF EXISTS app.day_plan_blocks_owner_match()");
    await bootstrap.query("DELETE FROM app.schema_migrations WHERE version = ANY($1)", [versions]);
    for (const name of await readdir(directory)) await rm(join(directory, name));
    await copyMigrations(names);
    await migrate();
  }

  async function actorQuery(actorId: string, statement: string, values: unknown[]) {
    const client = new Client({ connectionString: connectionStrings.app });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorId]);
      const result = await client.query(statement, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  async function plan(owner: string, day = "2026-09-12") {
    const id = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.day_plans (id, owner_user_id, local_day, time_zone)
       VALUES ($1, $2, $3, 'America/Los_Angeles')`,
      [id, owner, day]
    );
    return id;
  }

  async function block(planId: string, owner: string) {
    const id = randomUUID();
    await bootstrap.query(
      `INSERT INTO app.day_plan_blocks (id, plan_id, owner_user_id, kind)
       VALUES ($1, $2, $3, 'focus')`,
      [id, planId, owner]
    );
    return id;
  }

  async function snapshot() {
    const plans = await bootstrap.query("SELECT * FROM app.day_plans ORDER BY id");
    const blocks = await bootstrap.query("SELECT * FROM app.day_plan_blocks ORDER BY id");
    const operations = await bootstrap.query("SELECT * FROM app.day_plan_operations ORDER BY id");
    const ledger = await bootstrap.query(
      "SELECT version, checksum FROM app.schema_migrations WHERE version = ANY($1) ORDER BY version",
      [versions]
    );
    return [plans.rows, blocks.rows, operations.rows, ledger.rows];
  }

  async function expectForcedRls() {
    const result = await bootstrap.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid IN ('app.day_plans'::regclass, 'app.day_plan_blocks'::regclass,
                     'app.day_plan_operations'::regclass)`
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  }

  it("installs from the merged-primary schema using the migration owner", async () => {
    await baseline([]);
    await copyMigrations(files);
    const result = await migrate();
    expect(result.applied.map((file) => file.version)).toEqual(versions);
    const id = await plan(ids.userA);
    const blockId = await block(id, ids.userA);
    const rows = await bootstrap.query(
      "SELECT actual_placement, pending_change, legacy_0229_placement FROM app.day_plan_blocks WHERE id = $1",
      [blockId]
    );
    expect(rows.rows).toEqual([
      { actual_placement: null, pending_change: null, legacy_0229_placement: null }
    ]);
    await expectForcedRls();
  });

  it("preserves both actors' populated 0229 intent and placement without inventing commitment", async () => {
    await baseline([files[0]!]);
    const first = await plan(ids.userA);
    const second = await plan(ids.userB);
    for (const [id, capacity] of [
      [first, "light"],
      [second, "legacy capacity"]
    ]) {
      await bootstrap.query(
        "UPDATE app.day_plans SET priority = 'original priority', capacity = $2, notes = 'original notes' WHERE id = $1",
        [id, capacity]
      );
    }
    const actual = await block(first, ids.userA);
    const proposed = await block(second, ids.userB);
    const ambiguous = await block(first, ids.userA);
    for (const [id, placement, pending] of [
      [actual, "actual", "proposed"],
      [proposed, "proposed", null],
      [ambiguous, "proposed", "actual"]
    ]) {
      await bootstrap.query(
        `UPDATE app.day_plan_blocks SET placement = $2, proposed_placement = $3,
         starts_at = '2026-09-12T16:00:00Z', ends_at = '2026-09-12T17:00:00Z',
         duration_minutes = 60 WHERE id = $1`,
        [id, placement, pending]
      );
    }
    await copyMigrations(files);
    expect((await migrate()).applied.map((file) => file.version)).toEqual(versions.slice(1));
    const plans = await bootstrap.query("SELECT * FROM app.day_plans ORDER BY owner_user_id");
    expect(plans.rows.map((row) => row.legacy_0229_priority)).toEqual([
      "original priority",
      "original priority"
    ]);
    expect(plans.rows.map((row) => row.evening_intent)).toEqual([
      {
        priorityTaskIds: [],
        capacity: "light",
        notes: "original notes",
        corrections: [],
        commitments: []
      },
      {
        priorityTaskIds: [],
        capacity: null,
        notes: "original notes",
        corrections: [],
        commitments: []
      }
    ]);
    expect(plans.rows[1]?.legacy_0229_capacity).toBe("legacy capacity");
    const blocks = await bootstrap.query("SELECT * FROM app.day_plan_blocks");
    const actualRow = blocks.rows.find((row) => row.id === actual);
    const proposedRow = blocks.rows.find((row) => row.id === proposed);
    const ambiguousRow = blocks.rows.find((row) => row.id === ambiguous);
    expect(actualRow.actual_placement).toEqual({
      startsAt: "2026-09-12T16:00:00.000Z",
      durationMinutes: 60,
      calendarEventRef: null
    });
    expect(actualRow.pending_change).toBeNull();
    expect(actualRow.legacy_0229_proposed_placement).toBe("proposed");
    expect(proposedRow.actual_placement).toBeNull();
    expect(proposedRow.pending_change).toEqual({
      kind: "add",
      startsAt: "2026-09-12T16:00:00.000Z",
      durationMinutes: 60
    });
    expect(ambiguousRow.actual_placement).toBeNull();
    expect(ambiguousRow.pending_change).toBeNull();
    expect(ambiguousRow.legacy_0229_proposed_placement).toBe("actual");
    for (const row of blocks.rows) {
      expect(row.legacy_0229_starts_at.toISOString()).toBe("2026-09-12T16:00:00.000Z");
      expect(row.legacy_0229_ends_at.toISOString()).toBe("2026-09-12T17:00:00.000Z");
      expect(row.legacy_0229_duration_minutes).toBe(60);
    }
    const visible = await actorQuery(ids.userB, "SELECT id FROM app.day_plans", []);
    expect(visible.rows).toEqual([{ id: second }]);
    await expectForcedRls();
  });

  it("repairs blank 0229 notes after applied 0231 and round-trips through the repository", async () => {
    await baseline([files[0]!]);
    const fixtures = [
      { owner: ids.userA, day: "2026-09-13", notes: "", expected: null },
      { owner: ids.userB, day: "2026-09-13", notes: " \t\r\n", expected: null },
      { owner: ids.userA, day: "2026-09-14", notes: "\u00a0\u2003\ufeff", expected: null },
      { owner: ids.userB, day: "2026-09-14", notes: "original notes", expected: "original notes" },
      { owner: ids.userA, day: "2026-09-15", notes: " ", expected: "new typed note" }
    ];
    for (const fixture of fixtures) {
      const id = await plan(fixture.owner, fixture.day);
      await bootstrap.query(
        "UPDATE app.day_plans SET notes = $2, capacity = 'light' WHERE id = $1",
        [id, fixture.notes]
      );
    }
    // Exercise an installation that has already recorded the original reconciliation checksum.
    await copyMigrations(files.slice(0, 4));
    await migrate();
    await bootstrap.query(
      `UPDATE app.day_plans SET evening_intent = jsonb_set(evening_intent, '{notes}', '"new typed note"')
       WHERE local_day = '2026-09-15'`
    );
    const before = await snapshot();
    await copyMigrations(files);
    expect((await migrate()).applied.map((file) => file.version)).toEqual(["0232"]);
    const appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    const dataContext = new DataContextRunner(appDb);
    const repository = new DayPlanRepository({ findTask: async () => undefined });
    try {
      for (const fixture of fixtures) {
        const context = { actorUserId: fixture.owner, requestId: "legacy-notes-round-trip" };
        const input = { localDay: fixture.day, timeZone: "America/Los_Angeles" };
        const loaded = await dataContext.withDataContext(context, (db) =>
          repository.getForDay(db, input)
        );
        expect(loaded?.eveningIntent?.notes).toBe(fixture.expected);
        expect(loaded?.eveningIntent?.capacity).toBe("light");
        const saved = await dataContext.withDataContext(context, (db) =>
          repository.saveDraft(db, {
            ...input,
            planId: loaded!.id,
            expectedRevision: loaded!.revision
          })
        );
        expect(
          await dataContext.withDataContext(context, (db) => repository.getForDay(db, input))
        ).toEqual(saved);
        const raw = await actorQuery(
          fixture.owner,
          "SELECT legacy_0229_notes FROM app.day_plans WHERE id = $1",
          [loaded!.id]
        );
        expect(raw.rows).toEqual([{ legacy_0229_notes: fixture.notes }]);
      }
    } finally {
      await appDb.destroy();
    }
    const settled = await snapshot();
    expect(settled[3]).toEqual(expect.arrayContaining(before[3]!));
    expect((await migrate()).applied).toEqual([]);
    expect(await snapshot()).toEqual(settled);
    await expectForcedRls();
  });

  it("preserves existing 0230 rows and rejects cross-plan operation block references", async () => {
    await baseline([files[0]!, files[2]!]);
    const first = await plan(ids.userA);
    const sameOwner = await plan(ids.userA, "2026-09-13");
    const foreign = await plan(ids.userB);
    const ownedBlock = await block(first, ids.userA);
    const siblingBlock = await block(sameOwner, ids.userA);
    const foreignBlock = await block(foreign, ids.userB);
    await bootstrap.query(
      `UPDATE app.day_plan_blocks SET actual_placement = $2::jsonb,
       pending_change = '{"kind":"remove"}' WHERE id = $1`,
      [
        ownedBlock,
        JSON.stringify({
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 60,
          calendarEventRef: "fixture-event"
        })
      ]
    );
    const insert = `INSERT INTO app.day_plan_operations
      (id, plan_id, owner_user_id, block_id, kind, idempotency_key, expected_revision)
      VALUES ($1::uuid, $2, $3, $4, 'move', $1::uuid::text, 1)`;
    // Negative control: the original constraint permits the exact hidden-block attack.
    const unsafe = randomUUID();
    await actorQuery(ids.userA, insert, [unsafe, first, ids.userA, foreignBlock]);
    await bootstrap.query("DELETE FROM app.day_plan_operations WHERE id = $1", [unsafe]);
    const operation = randomUUID();
    await actorQuery(ids.userA, insert, [operation, first, ids.userA, ownedBlock]);
    const before = await snapshot();
    await copyMigrations(files);
    expect((await migrate()).applied.map((file) => file.version)).toEqual([
      "0229a",
      "0231",
      "0232"
    ]);
    const after = await snapshot();
    // New nullable legacy columns are the only additions to existing row values.
    for (let table = 0; table < 3; table++) {
      expect(after[table]).toHaveLength(before[table]!.length);
      before[table]!.forEach((row, index) => expect(after[table]![index]).toMatchObject(row));
    }
    for (const id of [siblingBlock, foreignBlock]) {
      await expect(
        actorQuery(ids.userA, insert, [randomUUID(), first, ids.userA, id])
      ).rejects.toThrow(/day_plan_operations_block_plan_fkey/);
      await expect(
        actorQuery(ids.userA, "UPDATE app.day_plan_operations SET block_id = $1 WHERE id = $2", [
          id,
          operation
        ])
      ).rejects.toThrow(/day_plan_operations_block_plan_fkey/);
    }
    await actorQuery(ids.userA, insert, [randomUUID(), first, ids.userA, null]);
    await actorQuery(ids.userA, "DELETE FROM app.day_plan_blocks WHERE id = $1", [ownedBlock]);
    const retained = await bootstrap.query(
      "SELECT plan_id, block_id FROM app.day_plan_operations WHERE id = $1",
      [operation]
    );
    expect(retained.rows).toEqual([{ plan_id: first, block_id: null }]);
    await expectForcedRls();
  });

  it("repeats both upgrade paths without data changes or checksum drift", async () => {
    for (const startingFiles of [[files[0]!], [files[0]!, files[2]!]]) {
      await baseline(startingFiles);
      await plan(ids.userA);
      await copyMigrations(files);
      await migrate();
      const before = await snapshot();
      const repeated = await migrate();
      expect(repeated.applied).toEqual([]);
      expect(repeated.skipped.map((file) => file.version)).toEqual(versions);
      expect(await snapshot()).toEqual(before);
      await expectForcedRls();
    }
  });
});
