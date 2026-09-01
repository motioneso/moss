import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

// #2159 — regression for the tools/list readiness race: nothing previously tied "the session
// is ready for a message" to "the MCP client's first tools/list has landed". This proves
// launchSession now awaits `waitForToolsListReady` (keyed off the minted token) AFTER
// engine.launch() and BEFORE the session becomes visible to ensureSession's caller — a
// manually-controlled (never auto-resolving) promise lets the test observe the gate actually
// blocking, not just get lucky on ordering.
//
// Split out of chat-session-manager.test.ts to keep both files under the repo's 1000-line cap.
describe("ChatSessionManager tools/list readiness gate (#2159)", () => {
  it("does not resolve ensureSession until waitForToolsListReady resolves", async () => {
    const engine = new FakeEngine(0);
    let releaseReady: (value: boolean) => void = () => {
      throw new Error("releaseReady called before it was assigned");
    };
    const readyGate = new Promise<boolean>((resolve) => {
      releaseReady = resolve;
    });
    const waitForToolsListReady = vi.fn().mockReturnValue(readyGate);
    const mintMcpToken = vi
      .fn()
      .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" });
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        mintMcpToken,
        waitForToolsListReady,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      }) as never
    );

    let resolved = false;
    const ensured = manager.ensureSession("u1", "Ben").then((session) => {
      resolved = true;
      return session;
    });

    // Engine launch already happened; the gate is what's holding the session back.
    await vi.waitFor(() => expect(engine.launchOpts).not.toBeNull());
    expect(resolved).toBe(false);

    releaseReady(true);
    await ensured;

    expect(resolved).toBe(true);
    expect(waitForToolsListReady).toHaveBeenCalledWith("jst_x");
  });

  it("proceeds without a token (no mintMcpToken configured) — no gate to wait on", async () => {
    const engine = new FakeEngine(0);
    const waitForToolsListReady = vi.fn();
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        waitForToolsListReady,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      }) as never
    );

    await manager.ensureSession("u1", "Ben");

    expect(waitForToolsListReady).not.toHaveBeenCalled();
  });

  it("rejects instead of letting the first message through when waitForToolsListReady times out (resolves false)", async () => {
    const engine = new FakeEngine(0);
    const waitForToolsListReady = vi.fn().mockResolvedValue(false);
    const mintMcpToken = vi
      .fn()
      .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" });
    const revokeMcpToken = vi.fn();
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        mintMcpToken,
        revokeMcpToken,
        waitForToolsListReady,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      }) as never
    );

    await expect(manager.ensureSession("u1", "Ben")).rejects.toThrow(CliChatUnavailableError);

    // #2164 QA — a timeout must not leak the process it just started or the token it just
    // minted: both the engine and the token registration must be torn down before the throw.
    expect(engine.killed).toBe(true);
    expect(revokeMcpToken).toHaveBeenCalledWith("u1:drawer");
  });
});
