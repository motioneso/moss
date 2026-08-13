import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RecoveryOutcome,
  ReapReason,
  ProviderChatRuntime,
  RuntimeHealth
} from "./provider-runtime.js";
import type { EngineLaunchOpts } from "./types.js";
import { PersistentRuntimePool } from "./persistent-runtime-pool.js";
import { computeIdleReapIntervalMs, startIdleReapTimer } from "./idle-reap-timer.js";

function fakeRuntime(health: RuntimeHealth) {
  const healthMock = vi.fn(async (): Promise<RuntimeHealth> => health);
  const reapMock = vi.fn(async (_reason: ReapReason) => {});
  const runtime: ProviderChatRuntime = {
    kind: "persistent",
    provider: "anthropic",
    launch: vi.fn(async () => {}),
    submitTurn: vi.fn(async () => {}),
    streamEvents: async function* () {},
    cancel: vi.fn(async () => ({ approvalsResolved: 0 })),
    health: healthMock,
    reap: reapMock,
    recover: vi.fn(
      async (): Promise<RecoveryOutcome> => ({ kind: "neutral-failure", reason: "n/a" })
    )
  };
  return { runtime, healthMock, reapMock };
}

function idleHealth(lastResultAt: number): RuntimeHealth {
  return { alive: true, state: "idle", turnsCompleted: 1, lastResultAt };
}

function busyHealth(): RuntimeHealth {
  return { alive: true, state: "in-turn", turnsCompleted: 1, lastResultAt: 0 };
}

const NOOP_OPTS = {} as EngineLaunchOpts;

describe("computeIdleReapIntervalMs", () => {
  it("is min(defaultIdleReapMinutes / 6, 5 min) — plan line 215", () => {
    expect(computeIdleReapIntervalMs(30)).toBe(5 * 60_000); // 30/6 = 5 min, at the cap
    expect(computeIdleReapIntervalMs(6)).toBe(1 * 60_000); // 6/6 = 1 min, below the cap
    expect(computeIdleReapIntervalMs(60)).toBe(5 * 60_000); // 60/6 = 10 min, capped to 5
  });
});

describe("startIdleReapTimer — mechanics", () => {
  it("ticks on the given interval, sweeping with the threshold from a live read (minutes -> ms)", async () => {
    vi.useFakeTimers();
    try {
      const sweepIdle = vi.fn(async (_ms: number) => {});
      const readIdleReapMinutes = vi.fn(async () => 30);
      const stop = startIdleReapTimer({
        pool: { sweepIdle },
        readIdleReapMinutes,
        intervalMs: 1_000
      });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(sweepIdle).toHaveBeenCalledTimes(3);
      expect(sweepIdle).toHaveBeenCalledWith(30 * 60_000);

      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sweepIdle).toHaveBeenCalledTimes(3); // no further ticks after stop()
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the threshold fresh on every tick — a changed setting takes effect without restart", async () => {
    vi.useFakeTimers();
    try {
      const sweepIdle = vi.fn(async (_ms: number) => {});
      let minutes = 30;
      const readIdleReapMinutes = vi.fn(async () => minutes);
      const stop = startIdleReapTimer({
        pool: { sweepIdle },
        readIdleReapMinutes,
        intervalMs: 1_000
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweepIdle).toHaveBeenLastCalledWith(30 * 60_000);

      minutes = 5; // live setting changed between ticks — must NOT be a boot-time snapshot
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweepIdle).toHaveBeenLastCalledWith(5 * 60_000);
      expect(readIdleReapMinutes.mock.calls.length).toBeGreaterThanOrEqual(2);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("in-flight guard: a slow sweep is never stacked by a subsequent tick", async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const held = new Promise<void>((res) => {
        release = res;
      });
      let concurrent = 0;
      let maxConcurrent = 0;
      const sweepIdle = vi.fn(async (_ms: number) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await held;
        concurrent -= 1;
      });
      const stop = startIdleReapTimer({
        pool: { sweepIdle },
        readIdleReapMinutes: async () => 30,
        intervalMs: 1_000
      });

      // Three ticks elapse while the first sweep is still pending.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sweepIdle).toHaveBeenCalledTimes(1);
      expect(maxConcurrent).toBe(1);

      release?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweepIdle).toHaveBeenCalledTimes(2); // resumes once the prior sweep settles

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a rejecting read/sweep via onError and keeps ticking on the next interval", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      let fail = true;
      const sweepIdle = vi.fn(async (_ms: number) => {});
      const readIdleReapMinutes = vi.fn(async () => {
        if (fail) throw new Error("boom");
        return 30;
      });
      const stop = startIdleReapTimer({
        pool: { sweepIdle },
        readIdleReapMinutes,
        intervalMs: 1_000,
        onError
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(sweepIdle).not.toHaveBeenCalled();

      fail = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweepIdle).toHaveBeenCalledTimes(1);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() is idempotent (double-stop is safe)", async () => {
    vi.useFakeTimers();
    try {
      const sweepIdle = vi.fn(async (_ms: number) => {});
      const stop = startIdleReapTimer({
        pool: { sweepIdle },
        readIdleReapMinutes: async () => 30,
        intervalMs: 1_000
      });
      stop();
      expect(() => stop()).not.toThrow();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sweepIdle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #1554 Decision 3 plan-stated test cases (plan lines 221-228): drive a REAL
// `PersistentRuntimePool` through the timer (not a fake pool), proving the end-to-end wiring —
// live-read minutes -> ms threshold -> `pool.sweepIdle` -> the pool's own idle/in-turn semantics
// (already proven in isolation by `persistent-runtime-pool.test.ts`).
describe("startIdleReapTimer + PersistentRuntimePool integration (plan Decision 3 test cases)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a child idle for 31 min is reaped (idle-timeout, onReap fires with that reason)", async () => {
    const { runtime, reapMock } = fakeRuntime(idleHealth(0));
    const onReap = vi.fn();
    const pool = new PersistentRuntimePool({
      cap: 1,
      createRuntime: () => runtime,
      clock: { now: () => Date.now() },
      onReap
    });
    await pool.admit("a", NOOP_OPTS);

    const stop = startIdleReapTimer({
      pool,
      readIdleReapMinutes: async () => 30,
      intervalMs: 60_000
    });

    await vi.advanceTimersByTimeAsync(31 * 60_000);

    expect(reapMock).toHaveBeenCalledWith("idle-timeout");
    expect(onReap).toHaveBeenCalledWith("a", "idle-timeout");
    stop();
  });

  it("a child idle for 29 min is NOT reaped", async () => {
    const { runtime, reapMock } = fakeRuntime(idleHealth(0));
    const pool = new PersistentRuntimePool({
      cap: 1,
      createRuntime: () => runtime,
      clock: { now: () => Date.now() }
    });
    await pool.admit("a", NOOP_OPTS);

    const stop = startIdleReapTimer({
      pool,
      readIdleReapMinutes: async () => 30,
      intervalMs: 60_000
    });

    await vi.advanceTimersByTimeAsync(29 * 60_000);

    expect(reapMock).not.toHaveBeenCalled();
    expect(pool.size()).toBe(1);
    stop();
  });

  it("a child in-turn for 40 min is NOT reaped (idle-reap keys off state, never wall-clock age)", async () => {
    const { runtime, reapMock } = fakeRuntime(busyHealth());
    const pool = new PersistentRuntimePool({
      cap: 1,
      createRuntime: () => runtime,
      clock: { now: () => Date.now() }
    });
    await pool.admit("a", NOOP_OPTS);

    const stop = startIdleReapTimer({
      pool,
      readIdleReapMinutes: async () => 30,
      intervalMs: 60_000
    });

    await vi.advanceTimersByTimeAsync(40 * 60_000);

    expect(reapMock).not.toHaveBeenCalled();
    expect(pool.size()).toBe(1);
    stop();
  });
});
