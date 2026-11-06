import { describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";

import type { createDatabase } from "@moss/db";
import type { createPgBossClient } from "@moss/jobs";
import type { createDiagnosticLogSink } from "@moss/settings";

import { buildWorker } from "../../apps/worker/src/worker.js";

// #3978 slice 2C: the shutdown function that buildWorker returns must flush the log sink,
// then destroy the database pool, then close the sink. The sink, pool and queue client are
// fakes that record call order.

const order = vi.hoisted(() => [] as string[]);

/** Any method call resolves to undefined, so startup wiring that is not under test is inert. */
function inert(extra: Record<string, unknown> = {}): unknown {
  const target: Record<string, unknown> = { ...extra };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop as string] : async () => undefined)
  });
}

vi.mock("@moss/db", async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & { createDatabase: typeof createDatabase }
  >();
  return {
    ...original,
    createDatabase: () => {
      // A real query builder over a driver that returns no rows.
      const db = new Kysely({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (k) => new PostgresIntrospector(k),
          createQueryCompiler: () => new PostgresQueryCompiler()
        }
      });
      db.destroy = async () => void order.push("destroy");
      return db;
    }
  };
});

vi.mock("@moss/jobs", async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & { createPgBossClient: typeof createPgBossClient }
  >();
  return {
    ...original,
    createPgBossClient: () =>
      inert({
        getQueue: async () => ({ name: "present" }),
        getSchedules: async () => [],
        work: async () => "worker-id",
        getQueues: async () => [],
        on: () => undefined,
        stop: async () => undefined
      })
  };
});

vi.mock("@moss/settings", async (importOriginal) => {
  const original = await importOriginal<
    Record<string, unknown> & { createDiagnosticLogSink: typeof createDiagnosticLogSink }
  >();
  return {
    ...original,
    createDiagnosticLogSink: () => ({
      enqueue: () => undefined,
      flush: async () => void order.push("flush"),
      close: async () => void order.push("close"),
      stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
    })
  };
});

describe("returned worker shutdown", () => {
  it("flushes the sink, destroys the pool, then closes the sink", async () => {
    const worker = await buildWorker({ connectionString: "postgres://unused/unused" });
    order.length = 0;
    await worker.shutdown();
    expect(order).toEqual(["flush", "destroy", "close"]);
  }, 60_000);
});
