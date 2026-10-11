import { describe, expect, it, vi } from "vitest";
import {
  ChatSessionManager,
  ChatThreadNotFoundError
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";

class FakeEngine {
  readonly provider = "anthropic" as const;
  launchOpts: EngineLaunchOpts | null = null;
  readonly submitted: string[] = [];
  killed = false;

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOpts = opts;
    return { offset: 0 };
  }
  async submit(text: string): Promise<void> {
    this.submitted.push(text);
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    return { records: [], offset: afterOffset, complete: true };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
}

function makeResumeDeps(touchResult: boolean, revokeMcpToken?: (chatSessionId: string) => void) {
  const engine = new FakeEngine();
  const deps = {
    engineFactory: vi.fn().mockReturnValue(engine),
    pollMs: 0,
    revokeMcpToken,
    persistence: {
      resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      openNewConversation: vi.fn().mockResolvedValue(undefined),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(touchResult)
    },
    personaFs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    },
    clock: { now: () => Date.now() },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "You are Jarvis."
  };
  return { deps, engine };
}

describe("ChatSessionManager.resumeThread", () => {
  it("happy-path: valid threadId — touchExistingThread called, session killed, revokeMcpToken invoked", async () => {
    const revokeMcpToken = vi.fn() as (chatSessionId: string) => void;
    const { deps, engine } = makeResumeDeps(true, revokeMcpToken);
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ben");
    expect(engine.killed).toBe(false);

    await manager.resumeThread("u1", "thread-abc");

    expect(deps.persistence.touchExistingThread).toHaveBeenCalledWith("u1", "thread-abc", "drawer");
    expect(engine.killed).toBe(true);
    expect(revokeMcpToken).toHaveBeenCalledWith("u1:drawer");
  });

  it("forces a replay on the next turn's relaunch after an explicit resume", async () => {
    const { deps } = makeResumeDeps(true);
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ben");
    await manager.resumeThread("u1", "thread-abc");

    deps.persistence.listPriorTurns.mockClear();
    await manager.ensureSession("u1", "Ben");

    expect(deps.persistence.listPriorTurns).toHaveBeenCalledWith(
      "u1",
      { forceReplay: true, threadId: null },
      "drawer"
    );
  });

  it("does not force replay on an ordinary relaunch with no prior resume", async () => {
    const { deps } = makeResumeDeps(true);
    const manager = new ChatSessionManager(deps);

    deps.persistence.listPriorTurns.mockClear();
    await manager.ensureSession("u1", "Ben");

    expect(deps.persistence.listPriorTurns).toHaveBeenCalledWith(
      "u1",
      { forceReplay: false, threadId: null },
      "drawer"
    );
  });

  it("not-found: touchExistingThread returns false → ChatThreadNotFoundError, active session untouched", async () => {
    const revokeMcpToken = vi.fn() as (chatSessionId: string) => void;
    const { deps, engine } = makeResumeDeps(false, revokeMcpToken);
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ben");

    await expect(manager.resumeThread("u1", "foreign-thread-id")).rejects.toBeInstanceOf(
      ChatThreadNotFoundError
    );

    expect(engine.killed).toBe(false);
    expect(revokeMcpToken).not.toHaveBeenCalled();
  });

  it("ordering guard: touchExistingThread runs BEFORE stopTurn (foreign id never disrupts live chat)", async () => {
    const callOrder: string[] = [];
    const engine = new FakeEngine();
    const manager = new ChatSessionManager({
      engineFactory: vi.fn().mockReturnValue(engine),
      pollMs: 0,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockImplementation(async () => {
          callOrder.push("touchExistingThread");
          return false;
        })
      },
      personaFs: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
      },
      clock: { now: () => Date.now() },
      idleMs: 60_000,
      neutralBase: "/tmp",
      persona: "You are Jarvis."
    });

    await manager.ensureSession("u1", "Ben");
    const origKill = engine.kill.bind(engine);
    engine.kill = vi.fn().mockImplementation(async () => {
      callOrder.push("engine.kill");
      return origKill();
    }) as unknown as FakeEngine["kill"];

    await expect(manager.resumeThread("u1", "bad-id")).rejects.toBeInstanceOf(
      ChatThreadNotFoundError
    );

    expect(callOrder).toContain("touchExistingThread");
    expect(callOrder).not.toContain("engine.kill");
  });
});
