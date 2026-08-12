/**
 * #1554 Decision 3 — `CliChatEngineHost.startIdleReapTimer` (the RPC topology's composition-root
 * idle-reap timer wiring; plan `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`,
 * lines 210-228). `persistentPool`/`readIdleReapMinutes` are OPTIONAL `EngineHostDeps` fields —
 * unset today (task #5, a later task, wires a real `PersistentRuntimePool` + live settings reader
 * and calls `startIdleReapTimer()` from `main.ts`). These tests only prove this host's OWN
 * arm/no-op/double-start/stop mechanics against a fake pool — the pool's reap semantics themselves
 * are covered by `persistent-runtime-pool.test.ts` and the integration cases in
 * `packages/chat/src/live/idle-reap-timer.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";

const NEUTRAL_BASE = "/tmp/jarvis-1554-decision3-neutral";

// startIdleReapTimer never touches `io` — a minimal never-invoked stub satisfies the type.
const io = {} as TmuxIo;

function makeHost(deps: { persistentPool?: { sweepIdle(ms: number): Promise<void> }; readIdleReapMinutes?: () => Promise<number> } = {}): CliChatEngineHost {
  return new CliChatEngineHost({
    io,
    neutralBase: NEUTRAL_BASE,
    singleUser: false,
    cliPresent: async () => true,
    ...deps
  });
}

describe("CliChatEngineHost.startIdleReapTimer (#1554 Decision 3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op (no timer armed) when persistentPool/readIdleReapMinutes are absent — true until task #5", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const host = makeHost();

    const stop = host.startIdleReapTimer(1_000);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(() => stop()).not.toThrow();
    expect(() => host.stopIdleReapTimer()).not.toThrow();
  });

  it("arms the timer and sweeps with the live-read threshold when both deps are present", async () => {
    vi.useFakeTimers();
    const sweepIdle = vi.fn(async (_ms: number) => {});
    const host = makeHost({
      persistentPool: { sweepIdle },
      readIdleReapMinutes: async () => 30
    });

    const stop = host.startIdleReapTimer(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweepIdle).toHaveBeenCalledTimes(2);
    expect(sweepIdle).toHaveBeenCalledWith(30 * 60_000);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepIdle).toHaveBeenCalledTimes(2); // no further ticks after the returned stop()
  });

  it("double-start guard: a second startIdleReapTimer() call clears the first timer, no orphan", async () => {
    vi.useFakeTimers();
    const sweepIdle = vi.fn(async (_ms: number) => {});
    const host = makeHost({
      persistentPool: { sweepIdle },
      readIdleReapMinutes: async () => 30
    });

    host.startIdleReapTimer(1_000);
    host.startIdleReapTimer(1_000); // must not leak/stack the first timer

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepIdle).toHaveBeenCalledTimes(1); // one live timer, not two

    host.stopIdleReapTimer();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepIdle).toHaveBeenCalledTimes(1); // fully cleared, no orphan keeps ticking
  });

  it("stopIdleReapTimer() halts further ticks and is idempotent", async () => {
    vi.useFakeTimers();
    const sweepIdle = vi.fn(async (_ms: number) => {});
    const host = makeHost({
      persistentPool: { sweepIdle },
      readIdleReapMinutes: async () => 30
    });

    host.startIdleReapTimer(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepIdle).toHaveBeenCalledTimes(1);

    host.stopIdleReapTimer();
    host.stopIdleReapTimer(); // idempotent
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweepIdle).toHaveBeenCalledTimes(1);
  });
});
