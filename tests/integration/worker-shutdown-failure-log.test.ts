import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type { createDatabase } from "@moss/db";

import { buildWorker, createShutdownHandler } from "../../apps/worker/src/worker.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const control = vi.hoisted(() => ({ failDestroy: false }));

// The pool is only really ended when the test lets it. A failing destroy leaves it open so
// the test can read what the shutdown wiring stored.
vi.mock("@moss/db", async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & { createDatabase: typeof createDatabase }
  >();
  return {
    ...original,
    createDatabase: (...args: Parameters<typeof original.createDatabase>) => {
      const db = original.createDatabase(...args);
      const realDestroy = db.destroy.bind(db);
      db.destroy = () =>
        control.failDestroy ? Promise.reject(new Error("pool end failed")) : realDestroy();
      return db;
    }
  };
});

// #3978 slice 2C: the returned worker's own shutdown, on a real database. When pool
// destruction fails, the shutdown-failed record must still reach the table, which only works
// if the sink is still open at that point.

let boot: pg.Client;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  boot = new Client({ connectionString: connectionStrings.bootstrap });
  await boot.connect();
}, 60_000);

afterAll(async () => {
  await boot?.end();
});

describe("worker shutdown failure", () => {
  it("stores shutdown-failed when the pool cannot be destroyed", async () => {
    const worker = await buildWorker({ connectionString: connectionStrings.worker });
    const exit = vi.fn();
    control.failDestroy = true;
    try {
      await createShutdownHandler(worker, {
        exit: exit as unknown as (code: number) => never,
        log: () => {}
      })();
    } finally {
      control.failDestroy = false;
    }
    expect(exit).toHaveBeenCalledWith(1);
    const { rows } = await boot.query(
      `SELECT process, level, event_code FROM app.diagnostic_log_records
       WHERE event_code = 'shutdown-failed'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ process: "worker", level: 60 });
  }, 90_000);
});
