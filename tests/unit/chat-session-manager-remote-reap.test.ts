import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { SessionTokenRegistry } from "../../packages/ai/src/gateway/session-tokens.js";
import { makeMinimalDeps } from "./chat-session-manager.test.js";

// #1554 Decision 2, test cases 3 & 4: `ChatSessionManager.handleRemoteReap` is the api-side
// half of the RPC `sessionReaped` push channel (see chat-session-manager.ts's own doc comment
// on the method). Split into its own file rather than appended to chat-session-manager.test.ts,
// which is already at the check:file-size 1000-line cap (repo convention — see
// chat-session-manager-provider-drop.test.ts / -selfheal.test.ts / -surface.test.ts, all split
// out of that same file for the same reason).

/** A minimal scriptable engine — only `launch` is exercised here. */
class FakeEngine {
  readonly provider = "anthropic" as const;
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
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

describe("ChatSessionManager.handleRemoteReap (#1554 Decision 2)", () => {
  it("a sessionReaped push for a cached sessionKey drops it and revokes its token exactly once", async () => {
    const registry = new SessionTokenRegistry();
    const revokeBySessionId = vi.spyOn(registry, "revokeBySessionId");
    const engineFactory = vi.fn(() => new FakeEngine() as never);
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        },
        revokeMcpToken: (sessionKey: string) => registry.revokeBySessionId(sessionKey)
      })
    );

    await manager.ensureSession("u1", "Ben");
    const sessionKey = surfaceSessionKey("u1", "drawer");

    await manager.handleRemoteReap(sessionKey, "idle-timeout");

    expect(revokeBySessionId).toHaveBeenCalledTimes(1);
    expect(revokeBySessionId).toHaveBeenCalledWith(sessionKey);

    // Proof the Map entry is actually gone (not just that revoke fired): a fresh ensureSession
    // for the same key relaunches a NEW engine instead of reusing the dropped one.
    await manager.ensureSession("u1", "Ben");
    expect(engineFactory).toHaveBeenCalledTimes(2);
  });

  it("a sessionReaped push for a sessionKey NOT cached no-ops — no revoke, no double-revoke", async () => {
    const registry = new SessionTokenRegistry();
    const revokeBySessionId = vi.spyOn(registry, "revokeBySessionId");
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: vi.fn(() => new FakeEngine() as never),
        revokeMcpToken: (sessionKey: string) => registry.revokeBySessionId(sessionKey)
      })
    );

    // Never called ensureSession — `sessions` is empty, so this key was either already
    // reconciled another way or was never a persistent session in this api process.
    await manager.handleRemoteReap(surfaceSessionKey("u-never-cached", "drawer"), "shutdown");

    expect(revokeBySessionId).not.toHaveBeenCalled();
  });
});
