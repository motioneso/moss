import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";

class FakeEngine {
  readonly provider = "anthropic" as const;
  readonly events: string[] = [];
  killed = false;
  purged = false;
  preserveNeutralDir = false;
  async launch(_opts: EngineLaunchOpts): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(_text: string): Promise<void> {}
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    return { records: [], offset: afterOffset, complete: true };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(opts?: { readonly preserveNeutralDir?: boolean }): Promise<void> {
    this.events.push("kill");
    this.killed = true;
    this.preserveNeutralDir = opts?.preserveNeutralDir ?? false;
  }
  async purgeTranscripts(): Promise<void> {
    this.events.push("purge");
    this.purged = true;
  }
  async interrupt(): Promise<void> {}
}

function privateDeps(engine: FakeEngine, incognito: boolean, now = () => 0) {
  return {
    engineFactory: () => engine,
    persistence: {
      resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      openNewConversation: vi.fn().mockResolvedValue(undefined),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true),
      getCurrentThreadState: vi.fn().mockResolvedValue({ id: "thread-private", incognito }),
      listIncognitoThreadStates: vi.fn().mockResolvedValue([]),
      deleteThread: vi.fn().mockResolvedValue(undefined)
    },
    personaFs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    },
    clock: { now },
    idleMs: 10,
    neutralBase: "/tmp",
    persona: "You are Jarvis."
  };
}

describe("ChatSessionManager private cleanup", () => {
  it("endPrivateSession best-effort purges, kills, and retains bookkeeping for the sweep", async () => {
    const engine = new FakeEngine();
    const revoke = vi.fn();
    const deps = privateDeps(engine, true);
    const manager = new ChatSessionManager({ ...deps, revokeMcpToken: revoke });
    await manager.ensureSession("u1", "Ben");

    await manager.endPrivateSession("u1");

    expect(engine.killed).toBe(true);
    expect(engine.purged).toBe(true);
    expect(engine.events).toEqual(["purge", "kill"]);
    expect(engine.preserveNeutralDir).toBe(true);
    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("u1:drawer");
  });

  it("retains a row across a live recreate race, then clears it after the post-exit sweep", async () => {
    let transcriptExists = true;
    const engine = new FakeEngine();
    engine.purgeTranscripts = vi.fn(async () => {
      engine.events.push("purge");
      transcriptExists = false;
      transcriptExists = true; // #1086 — the still-live CLI recreates after rm.
    });
    const deps = privateDeps(engine, true);
    deps.persistence.listIncognitoThreadStates.mockResolvedValue([
      { actorUserId: "u1", threadId: "thread-private" }
    ]);
    const purgePrivateTranscripts = vi.fn(async () => {
      transcriptExists = false;
    });
    const manager = new ChatSessionManager({ ...deps, purgePrivateTranscripts });
    await manager.ensureSession("u1", "Ben");

    await manager.endPrivateSession("u1");

    expect(transcriptExists).toBe(true);
    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();

    await manager.reconcileLiveSessions(new Set());

    expect(purgePrivateTranscripts).toHaveBeenCalledWith("u1:drawer");
    expect(transcriptExists).toBe(false);
    expect(deps.persistence.deleteThread).toHaveBeenCalledWith("u1", "thread-private", "drawer");
  });

  // #744 — the bookkeeping-row delete is GATED on purge success. If purge fails (throws) or
  // the engine has no purge method, the row MUST survive so the boot sweep can reclaim the
  // transcript; the live engine and token are still torn down.
  it("keeps the private bookkeeping row when the engine purge throws", async () => {
    const engine = new FakeEngine();
    engine.purgeTranscripts = vi.fn(async () => {
      engine.events.push("purge");
      throw new Error("rpc down");
    });
    const revoke = vi.fn();
    const deps = privateDeps(engine, true);
    const manager = new ChatSessionManager({ ...deps, revokeMcpToken: revoke });
    await manager.ensureSession("u1", "Ben");

    await manager.endPrivateSession("u1");

    expect(engine.killed).toBe(true);
    expect(engine.events).toEqual(["purge", "kill"]);
    expect(engine.preserveNeutralDir).toBe(true);
    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();
    // teardown still happens — a failed purge must not leave a dead engine live.
    expect(revoke).toHaveBeenCalledWith("u1:drawer");
  });

  it("refuses a private launch when the engine has no purge method", async () => {
    const engine = new FakeEngine();
    // Simulate an older RPC client that never implemented purgeTranscripts: the optional-chain
    // no-op that stranded transcripts on the split topology must now count as a FAILED purge.
    (engine as unknown as { purgeTranscripts?: () => Promise<void> }).purgeTranscripts = undefined;
    const deps = privateDeps(engine, true);
    const manager = new ChatSessionManager(deps);
    await expect(manager.ensureSession("u1", "Ben")).rejects.toThrow("private session unavailable");
    expect(engine.killed).toBe(false);
  });

  it("keeps the orphaned private row when the engine-less restart purge throws", async () => {
    const engine = new FakeEngine();
    const deps = privateDeps(engine, false);
    deps.persistence.getCurrentThreadState.mockResolvedValue(undefined);
    deps.persistence.listIncognitoThreadStates.mockResolvedValue([
      { actorUserId: "u1", threadId: "thread-private" }
    ]);
    const purgePrivateTranscripts = vi.fn().mockRejectedValue(new Error("fs down"));
    const manager = new ChatSessionManager({ ...deps, purgePrivateTranscripts });

    await manager.reconcileLiveSessions(new Set());

    expect(purgePrivateTranscripts).toHaveBeenCalledWith("u1:drawer");
    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();
  });

  it("keeps the orphaned private row when no engine-less purge path is wired", async () => {
    const engine = new FakeEngine();
    const deps = privateDeps(engine, false);
    deps.persistence.getCurrentThreadState.mockResolvedValue(undefined);
    deps.persistence.listIncognitoThreadStates.mockResolvedValue([
      { actorUserId: "u1", threadId: "thread-private" }
    ]);
    // No purgePrivateTranscripts dep → the sweep cannot confirm a purge → row survives.
    const manager = new ChatSessionManager(deps);

    await manager.reconcileLiveSessions(new Set());

    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();
  });

  it("reconcileLiveSessions purges stale private sessions before dropping them", async () => {
    const engine = new FakeEngine();
    const revoke = vi.fn();
    const killSession = vi.fn().mockResolvedValue(undefined);
    const deps = privateDeps(engine, true);
    const manager = new ChatSessionManager({
      ...deps,
      killSession,
      revokeMcpToken: revoke
    });
    await manager.ensureSession("u1", "Ben");

    await manager.reconcileLiveSessions(new Set());

    // A live session's own engine kill must run the stop-then-purge path directly;
    // killSession is reserved for the orphan-by-mux-name case and must not fire here
    // (Astra-Reviewer finding, 2026-09-09).
    expect(killSession).not.toHaveBeenCalled();
    expect(engine.killed).toBe(true);
    expect(engine.preserveNeutralDir).toBe(true);
    expect(engine.purged).toBe(true);
    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("u1:drawer");
  });

  it("reconcileLiveSessions sweeps orphaned private bookkeeping rows after api restart", async () => {
    const engine = new FakeEngine();
    const deps = privateDeps(engine, false);
    deps.persistence.getCurrentThreadState.mockResolvedValue(undefined);
    deps.persistence.listIncognitoThreadStates.mockResolvedValue([
      { actorUserId: "u1", threadId: "thread-private" }
    ]);
    const purgePrivateTranscripts = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatSessionManager({ ...deps, purgePrivateTranscripts });

    await manager.reconcileLiveSessions(new Set());

    expect(purgePrivateTranscripts).toHaveBeenCalledWith("u1:drawer");
    expect(deps.persistence.deleteThread).toHaveBeenCalledWith("u1", "thread-private", "drawer");
  });

  it("clear retains outgoing private bookkeeping until a later sweep", async () => {
    const engine = new FakeEngine();
    const deps = privateDeps(engine, true);
    const manager = new ChatSessionManager(deps);
    await manager.ensureSession("u1", "Ben");

    await manager.clear("u1");

    expect(engine.killed).toBe(true);
    expect(engine.purged).toBe(true);
    expect(deps.persistence.deleteThread).not.toHaveBeenCalled();
    expect(deps.persistence.openNewConversation).toHaveBeenCalledWith("u1", undefined, "drawer");
  });

  it("reapIdle skips private sessions with subscribers and reaps private sessions without subscribers", async () => {
    let now = 0;
    const kept = new FakeEngine();
    const keptDeps = privateDeps(kept, true, () => now);
    const keptManager = new ChatSessionManager(keptDeps);
    await keptManager.ensureSession("u1", "Ben");
    const unsubscribe = keptManager.subscribe("u1", () => undefined);
    now = 20;
    await keptManager.reapIdle();
    expect(kept.killed).toBe(false);
    unsubscribe();

    const reaped = new FakeEngine();
    const reapedDeps = privateDeps(reaped, true, () => now);
    const reapedManager = new ChatSessionManager(reapedDeps);
    await reapedManager.ensureSession("u1", "Ben");
    now = 40;
    await reapedManager.reapIdle();

    expect(reaped.killed).toBe(true);
    expect(reaped.purged).toBe(true);
    expect(reapedDeps.persistence.deleteThread).not.toHaveBeenCalled();
  });

  it("ends a private session after last subscriber detaches, unless a subscriber returns first", async () => {
    vi.useFakeTimers();
    try {
      const engine = new FakeEngine();
      const manager = new ChatSessionManager(privateDeps(engine, true));
      await manager.ensureSession("u1", "Ben");

      const first = manager.subscribe("u1", () => undefined);
      first();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(engine.killed).toBe(false);

      const second = manager.subscribe("u1", () => undefined);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(engine.killed).toBe(false);

      second();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(engine.killed).toBe(true);
      expect(engine.purged).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a private session while any subscriber remains attached", async () => {
    vi.useFakeTimers();
    try {
      const engine = new FakeEngine();
      const manager = new ChatSessionManager(privateDeps(engine, true));
      await manager.ensureSession("u1", "Ben");

      const first = manager.subscribe("u1", () => undefined);
      const second = manager.subscribe("u1", () => undefined);
      first();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(engine.killed).toBe(false);

      second();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(engine.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
