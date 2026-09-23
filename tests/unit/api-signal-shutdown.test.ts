/**
 * Unit test for the api graceful-shutdown helper (deployable-stack §9, AC#6).
 * Mirrors the worker lifecycle test idiom (tests/integration/worker-lifecycle.test.ts):
 * assert close() is invoked and the bounded-timeout race resolves before exit.
 */
import { describe, expect, it, vi } from "vitest";

import { shutdownOnSignal } from "../../apps/api/src/process-lifecycle.js";

describe("shutdownOnSignal (api graceful shutdown)", () => {
  it("calls server.close() then exits 0 when close resolves in time", async () => {
    const callOrder: string[] = [];
    const close = vi.fn((cb: (err?: Error) => void) => {
      callOrder.push("close");
      cb();
    });
    const exit = vi.fn((code: number) => {
      callOrder.push(`exit:${code}`);
    });

    await shutdownOnSignal({ close } as unknown as Parameters<typeof shutdownOnSignal>[0], {
      timeoutMs: 5_000,
      exit: exit as unknown as (code: number) => never
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["close", "exit:0"]);
  });

  it("still exits 0 when close hangs past the bounded timeout", async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => {
      /* never calls the callback -> hangs */
    });
    const exit = vi.fn();

    const pending = shutdownOnSignal(
      { close } as unknown as Parameters<typeof shutdownOnSignal>[0],
      { timeoutMs: 1_000, exit: exit as unknown as (code: number) => never }
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(exit).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });
});
