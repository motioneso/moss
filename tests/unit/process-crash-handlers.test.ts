/**
 * Unit tests for the crash-shutdown single-flight latch (spec §1140-E, #1527).
 *
 * Both apps/api/src/server.ts and apps/worker/src/worker.ts wrap their
 * unhandledRejection/uncaughtException listeners with a closure-local
 * `crashing` latch: the first crash logs + shuts down + races a bounded
 * timeout + exits; any later crash notification in the same window is a
 * no-op. Mirrors tests/unit/api-signal-shutdown.test.ts's stub/fake-timer
 * idiom.
 */
import { describe, expect, it, vi } from "vitest";

import { createCrashHandler as createApiCrashHandler } from "../../apps/api/src/server.js";
import { createCrashHandler as createWorkerCrashHandler } from "../../apps/worker/src/worker.js";

describe("createCrashHandler (api)", () => {
  it("logs, closes, and exits exactly once when called twice before shutdown settles", async () => {
    vi.useFakeTimers();
    const errorLog = vi.fn();
    const close = vi.fn(() => {
      /* never calls back -> hangs, so both calls race the same timer */
    });
    const exit = vi.fn();

    const handleCrash = createApiCrashHandler(
      { log: { error: errorLog }, close },
      { timeoutMs: 2_000, exit: exit as unknown as (code: number) => never }
    );

    handleCrash("unhandledRejection", new Error("first"));
    handleCrash("uncaughtException", new Error("second"));

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "first" }), label: "unhandledRejection" },
      "Process crash — exiting"
    );
    expect(close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it("exits 1 without waiting when close resolves promptly", async () => {
    const close = vi.fn((cb: (err?: Error) => void) => cb());
    const exit = vi.fn();

    const handleCrash = createApiCrashHandler(
      { log: { error: vi.fn() }, close },
      { timeoutMs: 2_000, exit: exit as unknown as (code: number) => never }
    );
    handleCrash("uncaughtException", new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits 1 after the bounded timeout when close hangs", async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => {
      /* hangs */
    });
    const exit = vi.fn();

    const handleCrash = createApiCrashHandler(
      { log: { error: vi.fn() }, close },
      { timeoutMs: 2_000, exit: exit as unknown as (code: number) => never }
    );
    handleCrash("unhandledRejection", new Error("boom"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});

describe("createCrashHandler (worker)", () => {
  it("logs, shuts down, and exits exactly once when called twice before shutdown settles", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const shutdown = vi.fn(
      () =>
        new Promise<void>(() => {
          /* never resolves -> hangs, so both calls race the same timer */
        })
    );
    const exit = vi.fn();

    const handleCrash = createWorkerCrashHandler(
      { shutdown },
      { timeoutMs: 2_000, exit: exit as unknown as (code: number) => never, log }
    );

    handleCrash("unhandledRejection", new Error("first"));
    handleCrash("uncaughtException", "not an error object");

    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(JSON.parse(line)).toEqual({
      level: "fatal",
      label: "unhandledRejection",
      err: "first",
      msg: "Process crash — exiting"
    });
    expect(shutdown).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it("exits 1 without waiting when shutdown resolves promptly", async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const exit = vi.fn();

    const handleCrash = createWorkerCrashHandler(
      { shutdown },
      { timeoutMs: 2_000, exit: exit as unknown as (code: number) => never, log: vi.fn() }
    );
    handleCrash("uncaughtException", new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits 1 after the bounded timeout when shutdown hangs", async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(
      () =>
        new Promise<void>(() => {
          /* hangs */
        })
    );
    const exit = vi.fn();

    const handleCrash = createWorkerCrashHandler(
      { shutdown },
      { timeoutMs: 2_000, exit: exit as unknown as (code: number) => never, log: vi.fn() }
    );
    handleCrash("unhandledRejection", new Error("boom"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
