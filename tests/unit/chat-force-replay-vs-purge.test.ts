import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { ChatSessionManagerDeps } from "../../packages/chat/src/live/chat-session-manager.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";

/**
 * #1039 — proves forceReplay (re-render from retained history) and purge (an incognito
 * session's history removed) are different mechanisms that cannot silently converge: a
 * forceReplay relaunch on a normal thread carries retained history into the fresh engine's
 * replayBatch, while the same forceReplay opt on an incognito thread never does, because the
 * incognito guard runs before replayBatch is ever built (chat-session-manager.ts:252-263).
 */

function makeEngine(opts?: { withPurge?: boolean }) {
  const engine: {
    launch: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    readNew: ReturnType<typeof vi.fn>;
    isAlive: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    purgeTranscripts?: ReturnType<typeof vi.fn>;
  } = {
    launch: vi.fn().mockResolvedValue({ offset: 0 }),
    submit: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    readNew: vi.fn().mockResolvedValue({ records: [], offset: 0, complete: true }),
    isAlive: vi.fn().mockResolvedValue(true),
    kill: vi.fn().mockResolvedValue(undefined)
  };
  if (opts?.withPurge) {
    engine.purgeTranscripts = vi.fn().mockResolvedValue(undefined);
  }
  return engine;
}

function makeManager(deps: {
  engine: ReturnType<typeof makeEngine>;
  listPriorTurns: ReturnType<typeof vi.fn>;
  getCurrentThreadState: ReturnType<typeof vi.fn>;
}): ChatSessionManager {
  return new ChatSessionManager({
    engineFactory: vi.fn().mockReturnValue(deps.engine),
    persistence: {
      resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "claude" }),
      listPriorTurns: deps.listPriorTurns,
      recordTurn: vi.fn(),
      openNewConversation: vi.fn(),
      getCurrentThreadState: deps.getCurrentThreadState,
      getThreadContext: vi.fn().mockResolvedValue({
        threadTitle: null,
        localTimezone: null,
        incognito: false
      }),
      touchExistingThread: vi.fn()
    },
    personaFs: { mkdir: vi.fn(), writeFile: vi.fn() },
    clock: { now: () => 0 },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "Jarvis",
    pollMs: 0
  } satisfies ChatSessionManagerDeps);
}

describe("forceReplay vs purge do not converge", () => {
  it("a forceReplay relaunch on a normal thread carries retained history into replayBatch", async () => {
    const engine = makeEngine();
    const listPriorTurns = vi.fn().mockResolvedValue({
      recent: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" }
      ],
      oldSummary: null
    });
    const getCurrentThreadState = vi.fn().mockResolvedValue({ id: "t1", incognito: false });
    const manager = makeManager({ engine, listPriorTurns, getCurrentThreadState });

    await manager.ensureSession("user-1", "User");
    await manager.switchProvider("user-1", "User");

    expect(listPriorTurns).toHaveBeenLastCalledWith("user-1", { forceReplay: true }, "drawer");
    const relaunchCall = engine.launch.mock.calls.at(-1)?.[0];
    expect(relaunchCall.replayBatch).toContain("q1");
    expect(relaunchCall.replayBatch).toContain("a1");
  });

  it("an incognito relaunch renders no replayBatch even when forceReplay: true is passed", async () => {
    const engine = makeEngine({ withPurge: true });
    // The D4 guard (persistence.ts:179-183, proven against a real DB by the integration
    // test's T2-e) guarantees an incognito listPriorTurns call always returns nothing --
    // this stub encodes that guarantee rather than re-proving it.
    const listPriorTurns = vi.fn().mockResolvedValue({ recent: [], oldSummary: null });
    const getCurrentThreadState = vi.fn().mockResolvedValue({ id: "t-priv", incognito: true });
    const manager = makeManager({ engine, listPriorTurns, getCurrentThreadState });

    await manager.ensureSession("user-1", "User", { forceReplay: true });

    expect(listPriorTurns).toHaveBeenCalledWith("user-1", { forceReplay: true }, "drawer");
    const launchCall = engine.launch.mock.calls.at(-1)?.[0];
    expect(launchCall.replayBatch).toBeUndefined();
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it("an incognito relaunch without engine purge support refuses to launch, regardless of forceReplay", async () => {
    const engine = makeEngine(); // no purgeTranscripts
    const listPriorTurns = vi.fn().mockResolvedValue({ recent: [], oldSummary: null });
    const getCurrentThreadState = vi.fn().mockResolvedValue({ id: "t-priv", incognito: true });
    const manager = makeManager({ engine, listPriorTurns, getCurrentThreadState });

    await expect(manager.ensureSession("user-1", "User", { forceReplay: true })).rejects.toThrow(
      CliChatUnavailableError
    );
  });
});
