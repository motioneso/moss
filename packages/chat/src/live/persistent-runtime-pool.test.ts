import { describe, expect, it, vi } from "vitest";
import type {
  ProviderChatRuntime,
  ReapReason,
  RecoveryOutcome,
  RuntimeHealth
} from "./provider-runtime.js";
import type { EngineLaunchOpts } from "./types.js";
import { PersistentRuntimePool } from "./persistent-runtime-pool.js";

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
    recover: vi.fn(async (): Promise<RecoveryOutcome> => ({ kind: "neutral-failure", reason: "n/a" }))
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

describe("PersistentRuntimePool.admit", () => {
  it("admits N <= cap sessions concurrently, all admitted, pool size == N, no reap calls", async () => {
    const created: ReturnType<typeof fakeRuntime>[] = [];
    const pool = new PersistentRuntimePool({
      cap: 3,
      createRuntime: () => {
        const fr = fakeRuntime(idleHealth(0));
        created.push(fr);
        return fr.runtime;
      },
      clock: { now: () => 0 }
    });

    const results = await Promise.all([
      pool.admit("a", NOOP_OPTS),
      pool.admit("b", NOOP_OPTS),
      pool.admit("c", NOOP_OPTS)
    ]);

    expect(results.every((r) => r.kind === "admitted")).toBe(true);
    expect(pool.size()).toBe(3);
    for (const fr of created) {
      expect(fr.reapMock).not.toHaveBeenCalled();
    }
  });

  it("denies the (cap+1)th when all existing are in-turn, zero reap calls", async () => {
    const created: ReturnType<typeof fakeRuntime>[] = [];
    const pool = new PersistentRuntimePool({
      cap: 2,
      createRuntime: () => {
        const fr = fakeRuntime(busyHealth());
        created.push(fr);
        return fr.runtime;
      },
      clock: { now: () => 0 }
    });

    await pool.admit("a", NOOP_OPTS);
    await pool.admit("b", NOOP_OPTS);
    const denied = await pool.admit("c", NOOP_OPTS);

    expect(denied).toEqual({ kind: "denied" });
    expect(pool.size()).toBe(2);
    for (const fr of created) {
      expect(fr.reapMock).not.toHaveBeenCalled();
    }
  });

  it("admits the (cap+1)th by evicting the least-recently-used idle child when two are idle", async () => {
    const byKey = new Map<string, ReturnType<typeof fakeRuntime>>();
    const onReap = vi.fn();
    const pool = new PersistentRuntimePool({
      cap: 2,
      createRuntime: (sessionKey) => {
        const health =
          sessionKey === "old-idle"
            ? idleHealth(100)
            : sessionKey === "new-idle"
              ? idleHealth(200)
              : idleHealth(0);
        const fr = fakeRuntime(health);
        byKey.set(sessionKey, fr);
        return fr.runtime;
      },
      onReap,
      clock: { now: () => 0 }
    });

    await pool.admit("old-idle", NOOP_OPTS);
    await pool.admit("new-idle", NOOP_OPTS);
    const result = await pool.admit("c", NOOP_OPTS);

    expect(result.kind).toBe("admitted");
    expect(byKey.get("old-idle")!.reapMock).toHaveBeenCalledWith("lru-evict");
    expect(byKey.get("new-idle")!.reapMock).not.toHaveBeenCalled();
    expect(onReap).toHaveBeenCalledWith("old-idle", "lru-evict");
    expect(pool.size()).toBe(2);
  });

  it("denies (no stale kill) when the idle victim transitions to in-turn between the scan and the atomic re-check", async () => {
    const scanHealth = idleHealth(0);
    let calls = 0;
    const healthMock = vi.fn(async (): Promise<RuntimeHealth> => {
      calls += 1;
      return calls === 1 ? scanHealth : busyHealth();
    });
    const reapMock = vi.fn(async () => {});
    const idleRuntime: ProviderChatRuntime = {
      kind: "persistent",
      provider: "anthropic",
      launch: vi.fn(async () => {}),
      submitTurn: vi.fn(async () => {}),
      streamEvents: async function* () {},
      cancel: vi.fn(async () => ({ approvalsResolved: 0 })),
      health: healthMock,
      reap: reapMock,
      recover: vi.fn(async (): Promise<RecoveryOutcome> => ({ kind: "neutral-failure", reason: "n/a" }))
    };

    const pool = new PersistentRuntimePool({
      cap: 1,
      createRuntime: () => idleRuntime,
      clock: { now: () => 0 }
    });

    await pool.admit("a", NOOP_OPTS);
    const result = await pool.admit("b", NOOP_OPTS);

    expect(result).toEqual({ kind: "denied" });
    expect(reapMock).not.toHaveBeenCalled();
    expect(pool.size()).toBe(1);
  });
});

describe("PersistentRuntimePool.release / sweepIdle", () => {
  it("release always reaps and untracks regardless of state", async () => {
    const { runtime, reapMock } = fakeRuntime(busyHealth());
    const pool = new PersistentRuntimePool({
      cap: 1,
      createRuntime: () => runtime,
      clock: { now: () => 0 }
    });

    await pool.admit("a", NOOP_OPTS);
    await pool.release("a", "incognito-end");

    expect(reapMock).toHaveBeenCalledWith("incognito-end");
    expect(pool.size()).toBe(0);
  });

  it("sweepIdle reaps only children idle past the threshold, re-checking health before reap", async () => {
    const { runtime: staleRuntime, reapMock: staleReap } = fakeRuntime(idleHealth(0));
    const { runtime: freshRuntime, reapMock: freshReap } = fakeRuntime(idleHealth(9_000));
    const pool = new PersistentRuntimePool({
      cap: 2,
      createRuntime: (sessionKey) => (sessionKey === "stale" ? staleRuntime : freshRuntime),
      clock: { now: () => 10_000 }
    });

    await pool.admit("stale", NOOP_OPTS);
    await pool.admit("fresh", NOOP_OPTS);
    await pool.sweepIdle(5_000);

    expect(staleReap).toHaveBeenCalledWith("idle-timeout");
    expect(freshReap).not.toHaveBeenCalled();
    expect(pool.size()).toBe(1);
  });
});
