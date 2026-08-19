/**
 * #1554 Decision 3 — `createChatSessionRuntime`'s wiring of the persistent-pool idle-reap timer
 * for the in-process topology (plan
 * `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`, lines 210-228: this function
 * IS the composition root the plan names for it, distinct from `engine-host.ts`'s RPC-topology
 * timer covered by `tests/unit/cli-runner-idle-reap-timer.test.ts`).
 *
 * `persistentPool`/`readIdleReapMinutes` are OPTIONAL `CreateChatSessionRuntimeDeps` fields — unset
 * today (task #5, a later task, constructs a real `PersistentRuntimePool` and wires a live settings
 * reader here). These tests only prove THIS function's arm/no-op/shutdown wiring against a fake
 * pool — reap semantics themselves are covered by `persistent-runtime-pool.test.ts` and
 * `packages/chat/src/live/idle-reap-timer.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatSessionRuntime } from "../../packages/chat/src/live/runtime.js";

// Neither `engineFactory` nor `engineSelection` is supplied below, so `createChatSessionRuntime`
// falls back to the module's back-compat `realEngineFactory` (unused — no launch happens in these
// tests) and never selects the RPC/socket path. Only `dataContext` is required to construct.
function fakeDataContext() {
  return {
    withDataContext: async (
      _access: { readonly actorUserId: string; readonly requestId: string },
      fn: (db: never) => unknown
    ) => fn({} as never)
  } as never;
}

describe("createChatSessionRuntime — persistent-pool idle-reap timer wiring (#1554 Decision 3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts no timer when persistentPool/readIdleReapMinutes are absent — true until task #5", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    const runtime = createChatSessionRuntime({ dataContext: fakeDataContext() });
    expect(setIntervalSpy).not.toHaveBeenCalled();

    expect(() => runtime.shutdown()).not.toThrow();
    expect(() => runtime.shutdown()).not.toThrow(); // idempotent
  });

  it("arms the timer and sweeps with the live-read threshold when both deps are present", async () => {
    vi.useFakeTimers();
    const sweepIdle = vi.fn(async (_ms: number) => {});

    const runtime = createChatSessionRuntime({
      dataContext: fakeDataContext(),
      persistentPool: { sweepIdle },
      readIdleReapMinutes: async () => 30,
      idleReapTimerIntervalMs: 1_000
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweepIdle).toHaveBeenCalledTimes(2);
    expect(sweepIdle).toHaveBeenCalledWith(30 * 60_000);

    runtime.shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepIdle).toHaveBeenCalledTimes(2); // shutdown() folded in the stop — no further ticks
  });

  it("reads the threshold fresh on every tick (not a boot-time snapshot)", async () => {
    vi.useFakeTimers();
    const sweepIdle = vi.fn(async (_ms: number) => {});
    let minutes = 30;

    const runtime = createChatSessionRuntime({
      dataContext: fakeDataContext(),
      persistentPool: { sweepIdle },
      readIdleReapMinutes: async () => minutes,
      idleReapTimerIntervalMs: 1_000
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepIdle).toHaveBeenLastCalledWith(30 * 60_000);

    minutes = 10;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepIdle).toHaveBeenLastCalledWith(10 * 60_000);

    runtime.shutdown();
  });
});
