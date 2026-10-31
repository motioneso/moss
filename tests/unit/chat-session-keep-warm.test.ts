import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { makeMinimalDeps } from "./chat-session-manager.test.js";

// #3854: users with hold-to-talk on keep a ready main chat session.

function makeEngine() {
  return {
    provider: "anthropic" as const,
    launch: vi.fn().mockResolvedValue({ offset: 0 }),
    submit: vi.fn().mockResolvedValue(undefined),
    readNew: vi.fn().mockResolvedValue({ records: [], offset: 0, complete: true }),
    isAlive: vi.fn().mockResolvedValue(true),
    kill: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined)
  };
}

function setup(keepWarm: { userIds: () => Promise<ReadonlySet<string>> } | undefined) {
  const engines: ReturnType<typeof makeEngine>[] = [];
  const engineFactory = vi.fn().mockImplementation(async () => {
    const engine = makeEngine();
    engines.push(engine);
    return engine;
  });
  const persistence = {
    resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
    listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
    recordTurn: vi.fn().mockResolvedValue(undefined),
    openNewConversation: vi.fn().mockResolvedValue(undefined),
    getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
    touchExistingThread: vi.fn().mockResolvedValue(true)
  };
  const manager = new ChatSessionManager(
    makeMinimalDeps({
      engineFactory,
      persistence,
      idleMs: -1,
      keepWarm: keepWarm && { ...keepWarm, resolveUserName: async () => "Ben" }
    })
  );
  return { manager, engines, engineFactory };
}

describe("keep-warm idle reaping", () => {
  it("keeps an idle session for a user in the keep-warm set", async () => {
    const { manager, engines } = setup({ userIds: async () => new Set(["u1"]) });
    await manager.ensureSession("u1", "Ben");
    await manager.reapIdle();
    expect(engines[0]!.kill).not.toHaveBeenCalled();
  });

  it("still reaps users outside the set", async () => {
    const { manager, engines } = setup({ userIds: async () => new Set(["u2"]) });
    await manager.ensureSession("u1", "Ben");
    await manager.reapIdle();
    expect(engines[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it("reaps a user who has left the set on the next run", async () => {
    let members = new Set(["u1"]);
    const { manager, engines } = setup({ userIds: async () => members });
    await manager.ensureSession("u1", "Ben");
    await manager.reapIdle();
    expect(engines[0]!.kill).not.toHaveBeenCalled();
    members = new Set();
    await manager.reapIdle();
    expect(engines[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it("reaps normally when no keep-warm port is wired", async () => {
    const { manager, engines } = setup(undefined);
    await manager.ensureSession("u1", "Ben");
    await manager.reapIdle();
    expect(engines[0]!.kill).toHaveBeenCalledTimes(1);
  });
});

describe("keep-warm recovery tick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a missing session for each user in the set", async () => {
    const { manager, engineFactory } = setup({ userIds: async () => new Set(["u1", "u2"]) });
    const stop = manager.startKeepWarm(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    stop();
  });

  it("brings a lost session back within one tick", async () => {
    const { manager, engineFactory } = setup({ userIds: async () => new Set(["u1"]) });
    const stop = manager.startKeepWarm(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await manager.handleRemoteReap("u1:drawer", "idle-timeout");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    stop();
  });

  it("launches nothing for an empty set", async () => {
    const { manager, engineFactory } = setup({ userIds: async () => new Set() });
    const stop = manager.startKeepWarm(60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(engineFactory).not.toHaveBeenCalled();
    stop();
  });

  it("does not start a timer without a keep-warm port", async () => {
    const { manager, engineFactory } = setup(undefined);
    const stop = manager.startKeepWarm(60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(engineFactory).not.toHaveBeenCalled();
    stop();
  });

  it("keeps going when one user fails to launch", async () => {
    const { manager, engineFactory } = setup({ userIds: async () => new Set(["bad", "u2"]) });
    engineFactory.mockImplementationOnce(async () => {
      throw new Error("launch failed");
    });
    const stop = manager.startKeepWarm(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    stop();
  });

  it("survives a failing set read and recovers on the next tick", async () => {
    const userIds = vi
      .fn<() => Promise<ReadonlySet<string>>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(new Set(["u1"]));
    const { manager, engineFactory } = setup({ userIds });
    const stop = manager.startKeepWarm(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engineFactory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engineFactory).toHaveBeenCalledTimes(1);
    stop();
  });

  it("shares one launch with a command racing the prestart", async () => {
    const { manager, engineFactory } = setup({ userIds: async () => new Set(["u1"]) });
    await Promise.all([manager.keepWarmTick(), manager.ensureSession("u1", "Ben")]);
    expect(engineFactory).toHaveBeenCalledTimes(1);
  });
});

// A page load opens /api/chat/stream, which subscribes and calls ensureSession for the
// drawer surface. Neither may end or relaunch a warm session.
describe("keep-warm session across a page load", () => {
  it("reuses the warm session when the drawer stream reconnects", async () => {
    const { manager, engines, engineFactory } = setup({ userIds: async () => new Set(["u1"]) });
    const first = await manager.ensureSession("u1", "Ben");

    const unsubscribeOld = manager.subscribe("u1", () => undefined, "drawer");
    unsubscribeOld();
    const unsubscribeNew = manager.subscribe("u1", () => undefined, "drawer");
    const reused = await manager.ensureSession("u1", "Ben", undefined, "drawer");

    expect(reused).toBe(first);
    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(engines[0]!.kill).not.toHaveBeenCalled();
    unsubscribeNew();
  });

  it("a voice request after a page load joins the same session", async () => {
    const { manager, engineFactory } = setup({ userIds: async () => new Set(["u1"]) });
    await manager.keepWarmTick();
    const unsubscribe = manager.subscribe("u1", () => undefined, "drawer");
    await manager.ensureSession("u1", "Ben", undefined, "drawer");
    const voice = await manager.ensureSession("u1", "Ben");
    const again = await manager.ensureSession("u1", "Ben");

    expect(voice).toBe(again);
    expect(engineFactory).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
