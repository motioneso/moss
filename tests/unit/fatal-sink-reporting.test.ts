import { describe, expect, it, vi } from "vitest";

import { runApiStartup, shutdownOnSignal } from "../../apps/api/src/process-lifecycle.js";
import {
  bootstrap,
  createCrashHandler,
  createShutdownHandler
} from "../../apps/worker/src/worker.js";
import type { DiagnosticLogRow, DiagnosticLogSink } from "@moss/settings";

// #3978 slice 2C: crash, startup and shutdown failures reach the log sink (and stderr), and the
// sink is drained before the process exits.

function fakeSink() {
  const rows: DiagnosticLogRow[] = [];
  const close = vi.fn(async () => {});
  const sink = {
    enqueue: (r: DiagnosticLogRow) => void rows.push(r),
    flush: async () => {},
    close,
    stats: () => ({ queued: 0, written: 0, dropped: 0, failed: 0 })
  } as DiagnosticLogSink;
  return { rows, close, sink };
}

describe("fatal reports reach the log sink", () => {
  it("api startup failure is stored as startup-failed and the sink drains before exit", async () => {
    const { rows, close, sink } = fakeSink();
    const order: string[] = [];
    close.mockImplementation(async () => void order.push("drain"));
    const lines: string[] = [];
    await runApiStartup(
      async () => {
        throw new Error("listen failed token=abc123secret");
      },
      {
        log: (l) => lines.push(l),
        sink: () => sink,
        exit: ((code: number) => {
          order.push(`exit${code}`);
        }) as never
      }
    );
    expect(lines).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 60, eventCode: "startup-failed", component: "api" });
    expect(JSON.stringify(rows[0])).not.toContain("abc123secret");
    expect(order).toEqual(["drain", "exit1"]);
  });

  it("api shutdown failure is stored as shutdown-failed", async () => {
    const { rows, sink } = fakeSink();
    await shutdownOnSignal(
      { close: (cb) => cb(new Error("close failed")) },
      { log: () => {}, sink: () => sink, exit: (() => {}) as never }
    );
    expect(rows[0]).toMatchObject({ eventCode: "shutdown-failed" });
  });

  it("worker shutdown failure is stored and drained before exit 1", async () => {
    const { rows, close, sink } = fakeSink();
    const exit = vi.fn();
    await createShutdownHandler(
      {
        shutdown: async () => {
          throw new Error("stop failed");
        }
      },
      { exit: exit as never, log: () => {}, sink: () => sink }
    )();
    expect(rows[0]).toMatchObject({ eventCode: "shutdown-failed", component: "worker" });
    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("worker startup failure is stored, drained and still written to stderr", async () => {
    const { rows, close, sink } = fakeSink();
    const lines: string[] = [];
    const exit = vi.fn();
    await bootstrap({
      build: async () => {
        throw new Error("no database");
      },
      log: (l) => lines.push(l),
      exit: exit as never,
      sink: () => sink
    });
    expect(lines).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventCode: "startup-failed" });
    expect(close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("worker crash is stored as crash and still written to stderr", () => {
    const { rows, sink } = fakeSink();
    const lines: string[] = [];
    createCrashHandler(
      { shutdown: async () => {} },
      { log: (l) => lines.push(l), exit: (() => {}) as never, sink: () => sink }
    )("uncaughtException", new Error("boom"));
    expect(lines).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 60, eventCode: "crash" });
  });
});
