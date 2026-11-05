import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { sql } from "kysely";

import type { createDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import { getAllQueueDefinitions } from "@moss/module-registry";

import { bootstrap, buildWorker } from "../../apps/worker/src/worker.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const control = vi.hoisted(() => ({ hangDestroy: false }));

// Kysely's destroy does nothing until the pool has served a query. In a running worker it
// always has, so the real database handle is touched once at creation to match that state.
vi.mock("@moss/db", async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & { createDatabase: typeof createDatabase }
  >();
  return {
    ...original,
    createDatabase: (...args: Parameters<typeof original.createDatabase>) => {
      const db = original.createDatabase(...args);
      void sql`select 1`.execute(db).catch(() => {});
      const realDestroy = db.destroy.bind(db);
      // A destroy that waits forever on a busy connection, when the test asks for it.
      db.destroy = () => (control.hangDestroy ? new Promise<void>(() => {}) : realDestroy());
      return db;
    }
  };
});

// #3978 slice 2C: the real worker startup, against a real migrated database with one
// pg-boss queue missing, must store a startup-failed record. The pool is destroyed only after
// the record is written, so the row has to be in the table afterwards.

let boot: pg.Client;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  boot = new Client({ connectionString: connectionStrings.bootstrap });
  await boot.connect();
  const admin = createPgBossClient(connectionStrings.migration);
  await admin.start();
  try {
    await admin.deleteQueue(getAllQueueDefinitions()[0]!.name);
  } finally {
    await admin.stop({ graceful: false });
  }
}, 60_000);

afterAll(async () => {
  await boot?.end();
});

describe("worker startup failure", () => {
  it("stores startup-failed in the log table when a queue is missing", async () => {
    const exit = vi.fn();
    const lines: string[] = [];
    await bootstrap({
      exit: exit as unknown as (code: number) => never,
      log: (line) => lines.push(line)
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);

    const { rows } = await boot.query(
      `SELECT process, level, component, event_code, message FROM app.diagnostic_log_records
       WHERE event_code = 'startup-failed'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ process: "worker", level: 60, component: "worker" });
  }, 60_000);

  it("still exits and stores the record when pool destruction never finishes", async () => {
    control.hangDestroy = true;
    try {
      const before = await boot.query(
        `SELECT count(*)::int AS n FROM app.diagnostic_log_records WHERE event_code = 'startup-failed'`
      );
      const exit = vi.fn();
      await bootstrap({
        build: () => buildWorker({ startupCleanupTimeoutMs: 300 }),
        exit: exit as unknown as (code: number) => never,
        log: () => {}
      });
      expect(exit).toHaveBeenCalledWith(1);
      const after = await boot.query(
        `SELECT count(*)::int AS n FROM app.diagnostic_log_records WHERE event_code = 'startup-failed'`
      );
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    } finally {
      control.hangDestroy = false;
    }
  }, 30_000);
});
