import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult
} from "kysely";

import type { MossDatabase } from "@moss/db";
import { createDiagnosticLogSink, type DiagnosticLogRow } from "@moss/settings";

// #3978 slice 2C: the sink's queue, caps, failure handling and shutdown, against a fake driver.

type Handler = (query: CompiledQuery) => Promise<void> | void;

function fakeDb(handler: Handler): { db: Kysely<MossDatabase>; inserts: CompiledQuery[] } {
  const inserts: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (/insert into/i.test(query.sql)) inserts.push(query);
      await handler(query);
      return { rows: [] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error("not used");
    }
  };
  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {}
      })
    }
  });
  return { db, inserts };
}

function row(n = 0, over: Partial<DiagnosticLogRow> = {}): DiagnosticLogRow {
  return {
    occurredAt: new Date(1_700_000_000_000).toISOString(),
    process: "worker",
    level: 40,
    component: "connectors",
    connectionKind: null,
    eventCode: null,
    ownerUserId: null,
    message: `m${n}`,
    context: {},
    truncated: false,
    ...over
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("diagnostic log sink", () => {
  it("returns from enqueue without waiting on a database that never answers", async () => {
    const { db } = fakeDb(() => new Promise<void>(() => {}));
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) sink.enqueue(row(i));
    expect(performance.now() - started).toBeLessThan(50);
    expect(sink.stats().queued).toBeLessThanOrEqual(500);
  });

  it("keeps one flush at a time and ends a stuck flush at its deadline", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const { db } = fakeDb(async (q) => {
      if (!/insert into/i.test(q.sql)) return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(() => {});
    });
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    sink.enqueue(row(1));
    const first = sink.flush();
    const second = sink.flush();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(5100);
    await first;
    expect(maxActive).toBe(1);
    expect(sink.stats().failed).toBe(1);
    expect(sink.stats().dropped).toBe(1);
  });

  it("swallows a failing database and keeps accepting records", async () => {
    const { db } = fakeDb((q) => {
      if (/insert into/i.test(q.sql)) throw new Error("db down");
    });
    const lines: string[] = [];
    const sink = createDiagnosticLogSink({ db, process: "api", stderr: (l) => lines.push(l) });
    expect(() => sink.enqueue(row(1))).not.toThrow();
    await sink.flush();
    expect(sink.stats().failed).toBe(1);
    expect(() => sink.enqueue(row(2))).not.toThrow();
    expect(sink.stats().queued).toBe(1);
    expect(lines.join("")).not.toContain("db down");
  });

  it("reports sink trouble to stderr at most once a minute, never to a logger", async () => {
    let now = 1_000_000;
    const { db } = fakeDb((q) => {
      if (/insert into/i.test(q.sql)) throw new Error("db down");
    });
    const lines: string[] = [];
    const sink = createDiagnosticLogSink({
      db,
      process: "api",
      now: () => now,
      stderr: (l) => lines.push(l)
    });
    for (let i = 0; i < 3; i += 1) {
      sink.enqueue(row(i));
      await sink.flush();
    }
    expect(lines).toHaveLength(1);
    now += 61_000;
    sink.enqueue(row(9));
    await sink.flush();
    expect(lines).toHaveLength(2);
  });

  it("stores at most 200 a minute plus one summary, and never queues more than 500", async () => {
    let now = 5_000_000;
    const { db, inserts } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({
      db,
      process: "worker",
      now: () => now,
      stderr: () => {}
    });
    let maxQueued = 0;
    for (let i = 0; i < 10_000; i += 1) {
      sink.enqueue(row(i));
      maxQueued = Math.max(maxQueued, sink.stats().queued);
    }
    expect(maxQueued).toBeLessThanOrEqual(500);
    await sink.flush();
    expect(sink.stats().written).toBe(200);
    expect(sink.stats().dropped).toBe(9_800);
    // The next minute opens with one summary carrying the exact count.
    now += 60_000;
    sink.enqueue(row(1));
    await sink.flush();
    const last = inserts.at(-1)!;
    expect(last.parameters).toContain("log.dropped");
    expect(JSON.stringify(last.parameters)).toContain("dropped 9800 log records");
    expect(sink.stats().written).toBe(202);
  });

  it("drops the oldest queued records first when the byte cap is hit", async () => {
    const { db, inserts } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    const big = "x".repeat(3000);
    for (let i = 0; i < 190; i += 1) sink.enqueue(row(i, { message: `${i}:${big}` }));
    expect(sink.stats().dropped).toBeGreaterThan(0);
    await sink.flush();
    const all = JSON.stringify(inserts.map((q) => q.parameters));
    expect(all).toContain("189:");
    expect(all).not.toContain('"0:x');
  });

  it("refuses a single record over 4 KB", () => {
    const { db } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    sink.enqueue(row(1, { message: "y".repeat(5000) }));
    expect(sink.stats()).toMatchObject({ queued: 0, dropped: 1 });
  });

  it("retries a batch without owners after a foreign-key failure", async () => {
    let first = true;
    const { db, inserts } = fakeDb((q) => {
      if (/insert into/i.test(q.sql) && first) {
        first = false;
        throw Object.assign(new Error("fk"), { code: "23503" });
      }
    });
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    const owner = "00000000-0000-4000-8000-0000000000aa";
    sink.enqueue(row(1, { ownerUserId: owner }));
    await sink.flush();
    expect(sink.stats().written).toBe(1);
    expect(JSON.stringify(inserts[0]!.parameters)).toContain(owner);
    expect(JSON.stringify(inserts[1]!.parameters)).not.toContain(owner);
  });

  it("pauses 30 seconds on a missing table, then recovers", async () => {
    let now = 1_000;
    let missing = true;
    const { db, inserts } = fakeDb((q) => {
      if (/insert into/i.test(q.sql) && missing) {
        throw Object.assign(new Error("no table"), { code: "42P01" });
      }
    });
    const sink = createDiagnosticLogSink({
      db,
      process: "worker",
      now: () => now,
      stderr: () => {}
    });
    sink.enqueue(row(1));
    await sink.flush();
    expect(inserts).toHaveLength(1);
    sink.enqueue(row(2));
    now += 10_000;
    await sink.flush();
    expect(inserts).toHaveLength(1);
    missing = false;
    now += 21_000;
    await sink.flush();
    expect(inserts).toHaveLength(2);
    expect(sink.stats().written).toBe(1);
  });

  it("flushes what is queued on close, then ignores later records", async () => {
    const { db, inserts } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({ db, process: "api", stderr: () => {} });
    sink.enqueue(row(1));
    sink.enqueue(row(2));
    await sink.close();
    expect(sink.stats().written).toBe(2);
    expect(inserts).toHaveLength(1);
    sink.enqueue(row(3));
    expect(sink.stats().queued).toBe(0);
    await sink.close();
    expect(inserts).toHaveLength(1);
  });

  it("returns from close within two seconds when the database hangs", async () => {
    vi.useFakeTimers();
    const { db } = fakeDb(() => new Promise<void>(() => {}));
    const sink = createDiagnosticLogSink({ db, process: "api", stderr: () => {} });
    sink.enqueue(row(1));
    let done = false;
    const closing = sink.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2100);
    await closing;
    expect(done).toBe(true);
  });

  it("never starts a second write while a timed-out write is still outstanding", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const { db } = fakeDb(async (q) => {
      if (!/insert into/i.test(q.sql)) return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(() => {});
    });
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    sink.enqueue(row(1));
    await vi.advanceTimersByTimeAsync(5500);
    sink.enqueue(row(2));
    await vi.advanceTimersByTimeAsync(20_000);
    await sink.flush();
    expect(maxActive).toBe(1);
    expect(sink.stats().queued).toBe(1);
  });

  it("counts JSON escaping when sizing a record", () => {
    const { db } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    sink.enqueue(row(1, { message: '"'.repeat(2048), context: { a: "x".repeat(1000) } }));
    expect(sink.stats()).toMatchObject({ queued: 0, dropped: 1 });
  });

  it("writes the drop summary after a quiet minute with no further records", async () => {
    let now = 9_000_000;
    const { db, inserts } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({
      db,
      process: "worker",
      now: () => now,
      stderr: () => {}
    });
    for (let i = 0; i < 201; i += 1) sink.enqueue(row(i));
    await sink.flush();
    now += 61_000;
    await sink.flush();
    expect(JSON.stringify(inserts.at(-1)!.parameters)).toContain("dropped 1 log records");
  });

  it("writes a pending drop summary on close", async () => {
    const { db, inserts } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    for (let i = 0; i < 201; i += 1) sink.enqueue(row(i));
    await sink.close();
    expect(JSON.stringify(inserts.map((q) => q.parameters))).toContain("dropped 1 log records");
  });

  it("writes at most 200 records a minute to the database after a backlog builds", async () => {
    let now = 20_000_000;
    const { db } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({
      db,
      process: "worker",
      now: () => now,
      stderr: () => {}
    });
    for (let minute = 0; minute < 3; minute += 1) {
      for (let i = 0; i < 200; i += 1) sink.enqueue(row(i));
      now += 61_000;
    }
    await sink.flush();
    // 200 records plus at most the two drop summaries.
    expect(sink.stats().written).toBeGreaterThanOrEqual(200);
    expect(sink.stats().written).toBeLessThanOrEqual(202);
    expect(sink.stats().queued).toBeGreaterThanOrEqual(298);
    now += 61_000;
    await sink.flush();
    // 400 records plus at most the one drop summary.
    expect(sink.stats().written).toBeGreaterThanOrEqual(400);
    expect(sink.stats().written).toBeLessThanOrEqual(404);
  });

  it("reports queue evictions in a drop summary after a flush and then silence", async () => {
    vi.useFakeTimers();
    const { db, inserts } = fakeDb(() => {});
    const sink = createDiagnosticLogSink({ db, process: "worker", stderr: () => {} });
    const big = "x".repeat(3000);
    // The byte cap evicts the oldest records inside the first minute.
    for (let i = 0; i < 190; i += 1) sink.enqueue(row(i, { message: `${i}:${big}` }));
    expect(sink.stats().dropped).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(500);
    const before = inserts.length;
    expect(before).toBeGreaterThan(0);
    // Nothing else is logged. The summary timer alone must get the count written.
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(inserts.length).toBeGreaterThan(before);
    expect(JSON.stringify(inserts.at(-1)!.parameters)).toMatch(/dropped \d+ log records/);
  });

  it("holds the queue at 500 across minute windows while a write is stuck", async () => {
    let now = 40_000_000;
    const { db } = fakeDb(() => new Promise<void>(() => {}));
    const sink = createDiagnosticLogSink({
      db,
      process: "worker",
      now: () => now,
      stderr: () => {}
    });
    sink.enqueue(row(0));
    void sink.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let max = 0;
    for (let minute = 0; minute < 5; minute += 1) {
      for (let i = 0; i < 200; i += 1) {
        sink.enqueue(row(i));
        max = Math.max(max, sink.stats().queued);
      }
      now += 61_000;
    }
    expect(max).toBeLessThanOrEqual(500);
    expect(max).toBeGreaterThan(400);
    expect(sink.stats().dropped).toBeGreaterThanOrEqual(500);
  });
});
