import { describe, expect, it, vi } from "vitest";

import { createCrashHandler as apiCrash } from "../../apps/api/src/process-lifecycle.js";
import { createCrashHandler as workerCrash } from "../../apps/worker/src/worker.js";
import Fastify from "fastify";
import { recordingLoggerOptions } from "../../apps/api/src/recording-logger-options.js";
import type { DiagnosticLogRow, DiagnosticLogSink } from "@moss/settings";

// #3978 slice 2C re-review: crash and shutdown paths against a sink that models closure
// (a record enqueued after close is lost, as in the real sink).

function closingSink() {
  const rows: DiagnosticLogRow[] = [];
  const state = { closed: false };
  const sink = {
    enqueue: (r: DiagnosticLogRow) => {
      if (!state.closed) rows.push(r);
    },
    flush: async () => {},
    close: async () => {
      state.closed = true;
    },
    stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
  } as DiagnosticLogSink;
  return { rows, state, sink };
}

const asExit = (fn: unknown) => fn as (code: number) => never;

describe("worker crash path", () => {
  it("exits 1 and stores the record when shutdown rejects", async () => {
    const { rows, state, sink } = closingSink();
    const exit = vi.fn();
    const handle = workerCrash(
      { shutdown: () => Promise.reject(new Error("pool refused to close")) },
      { exit: asExit(exit), log: () => {}, sink: () => sink }
    );
    handle("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(state.closed).toBe(true);
    expect(rows.map((r) => r.eventCode)).toEqual(["crash"]);
  });

  it("drains the sink while shutdown is still stuck", async () => {
    vi.useFakeTimers();
    try {
      const { rows, state, sink } = closingSink();
      const exit = vi.fn();
      const handle = workerCrash(
        { shutdown: () => new Promise<void>(() => {}) },
        { timeoutMs: 2000, exit: asExit(exit), log: () => {}, sink: () => sink }
      );
      handle("unhandledRejection", new Error("boom"));
      await vi.advanceTimersByTimeAsync(10);
      expect(state.closed).toBe(true);
      expect(rows).toHaveLength(1);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("api crash path", () => {
  it("queues the crash row through the real logger before exit, and writes stderr", async () => {
    vi.useFakeTimers();
    try {
      const { rows, state, sink } = closingSink();
      const stdout: string[] = [];
      const app = Fastify({
        logger: recordingLoggerOptions(
          { stream: { write: (c: string) => (stdout.push(c), true) } } as never,
          { sink }
        )
      });
      const logger = app.log;
      const seen: { rows: number; closed: boolean }[] = [];
      const exit = vi.fn(() => seen.push({ rows: rows.length, closed: state.closed }));
      const lines: string[] = [];
      const handle = apiCrash(
        { log: logger, close: () => {} },
        { timeoutMs: 2000, exit: asExit(exit), log: (l) => lines.push(l), sink: () => sink }
      );
      handle("uncaughtException", new Error("boom token=abc123secret"));
      await vi.advanceTimersByTimeAsync(10);
      expect(rows.map((r) => r.eventCode)).toEqual(["crash"]);
      expect(JSON.stringify(rows)).not.toContain("abc123secret");
      expect(stdout.join("")).not.toContain("abc123secret");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ level: "fatal", label: "uncaughtException" });
      expect(lines[0]).not.toContain("abc123secret");
      expect(state.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(seen).toEqual([{ rows: 1, closed: true }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
