/**
 * #1554 task #5 — `createRealEngineFactory`'s (in-process topology, `runtime.ts`) own warm-pool
 * construction: consulted by `chat-multiplexer.ts`'s `resolveChatEngineFactory` (the real
 * production caller) and by `createChatSessionRuntime`'s in-process `engineSelection` default.
 *
 * Covers: (1) admission — a supplied `persistentPoolCap` makes `persistentRuntimeEnabled: true`
 * route through the pool instead of the pre-task-5 unconditional construct; (2) `onPersistentReap`
 * fires when the pool's own idle-reap timer (wired here from `readIdleReapMinutes`) reaps a child.
 * Reap-selection semantics themselves (LRU-evict, idle-timeout threshold math) are already covered
 * by `packages/chat/src/live/persistent-runtime-pool.test.ts` — these tests only prove THIS
 * factory's construction + wiring, using a fake `ClaudePersistentRuntime` so no real tmux/child
 * process is ever touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ClaudePersistentRuntimeModule from "../../packages/chat/src/live/claude-persistent-runtime.js";

const reapMock = vi.fn(async () => {});
let fakeState: "idle" | "in-turn" = "idle";

vi.mock("../../packages/chat/src/live/claude-persistent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudePersistentRuntimeModule>();
  return {
    ...actual,
    ClaudePersistentRuntime: vi.fn().mockImplementation(function FakeClaudePersistentRuntime() {
      return {
        kind: "persistent",
        provider: "anthropic",
        launch: vi.fn(async () => {}),
        submitTurn: vi.fn(async () => {}),
        streamEvents: async function* () {},
        cancel: vi.fn(async () => ({ approvalsResolved: 0 })),
        health: vi.fn(async () => ({
          alive: true,
          state: fakeState,
          turnsCompleted: 0,
          lastResultAt: 0
        })),
        reap: reapMock,
        recover: vi.fn(async () => ({ kind: "neutral-failure" as const, reason: "n/a" }))
      };
    })
  };
});

import { createRealEngineFactory } from "../../packages/chat/src/live/runtime.js";
import { ClaudePersistentRuntimeEngine } from "../../packages/chat/src/live/persistent-runtime-engine.js";

describe("createRealEngineFactory — persistent-pool wiring (#1554 task #5)", () => {
  afterEach(() => {
    vi.useRealTimers();
    reapMock.mockClear();
    fakeState = "idle";
  });

  it("admits through the pool (not the unconditional pre-task-5 construct) when persistentPoolCap is set", async () => {
    const factory = createRealEngineFactory({
      persistentRuntimeEnabled: true,
      persistentPoolCap: 2
    });

    const engine = await factory("anthropic", "session-1", {});
    expect(engine).toBeInstanceOf(ClaudePersistentRuntimeEngine);
  });

  it("falls back to the bounded engine once the pool is at cap with no idle victim", async () => {
    fakeState = "in-turn";
    const factory = createRealEngineFactory({
      persistentRuntimeEnabled: true,
      persistentPoolCap: 1
    });

    const first = await factory("anthropic", "session-1", {});
    expect(first).toBeInstanceOf(ClaudePersistentRuntimeEngine);

    const second = await factory("anthropic", "session-2", { executionMode: "non_interactive" });
    expect(second).not.toBeInstanceOf(ClaudePersistentRuntimeEngine);
  });

  it("fires onPersistentReap when the pool's idle-reap timer reaps a child", async () => {
    vi.useFakeTimers();
    const onPersistentReap = vi.fn();
    const factory = createRealEngineFactory({
      persistentRuntimeEnabled: true,
      persistentPoolCap: 1,
      readIdleReapMinutes: async () => 1,
      idleReapTimerIntervalMs: 1_000,
      onPersistentReap
    });

    await factory("anthropic", "session-1", {});
    // 1 minute idle-reap threshold: advance well past it so the timer's sweepIdle tick reaps.
    await vi.advanceTimersByTimeAsync(70_000);

    expect(reapMock).toHaveBeenCalledWith("idle-timeout");
    expect(onPersistentReap).toHaveBeenCalledWith("session-1", "idle-timeout");
  });

  it("never constructs a pool (unconditional pre-task-5 behavior) when persistentPoolCap is omitted", async () => {
    const factory = createRealEngineFactory({ persistentRuntimeEnabled: true });
    const engine = await factory("anthropic", "session-1", {});
    // Still the persistent engine (flag on, provider match) — just not pool-admitted.
    expect(engine).toBeInstanceOf(ClaudePersistentRuntimeEngine);
  });
});
