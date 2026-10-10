import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

// #3156: a fresh launch replays the accepted summary plus every uncovered turn. When that
// retained context cannot fit the launch budget, the launch must fail with the existing
// actionable unavailable error instead of truncating, tear down what it started, and ask
// for the conversation to be condensed.

const threadId = "00000000-0000-4000-8000-000000000031";

function turns(count: number, size: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `${i}:`.padEnd(size, "x")
  }));
}

function setup(recent: ReturnType<typeof turns>, oldSummary: string | null = null) {
  const engine = new FakeEngine(0);
  const requestConversationSummary = vi.fn().mockResolvedValue(undefined);
  const revokeMcpToken = vi.fn();
  const listPriorTurns = vi.fn().mockResolvedValue({ recent, oldSummary });
  const manager = new ChatSessionManager(
    makeMinimalDeps({
      engineFactory: () => engine,
      mintMcpToken: vi
        .fn()
        .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" }),
      waitForToolsListReady: vi.fn().mockResolvedValue(true),
      revokeMcpToken,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns,
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true),
        getCurrentThreadState: vi.fn().mockResolvedValue({ id: threadId, incognito: false }),
        requestConversationSummary
      }
    }) as never
  );
  return { manager, engine, requestConversationSummary, revokeMcpToken };
}

afterEach(() => vi.unstubAllEnvs());

describe("fresh launch replay budget (#3156)", () => {
  it("launches when the summary and uncovered turns fit", async () => {
    vi.stubEnv("JARVIS_CHAT_REPLAY_TOKENS", "2000");
    const { manager, engine, requestConversationSummary } = setup(turns(4, 400), "Decided: blue");
    await manager.ensureSession("u1", "Ben");
    expect(engine.launchOpts?.replayBatch).toContain("Decided: blue");
    expect(engine.launchOpts?.replayBatch).toContain("3:");
    expect(requestConversationSummary).not.toHaveBeenCalled();
  });

  it("refuses an over-budget resume, tears down, and requests condensing", async () => {
    vi.stubEnv("JARVIS_CHAT_REPLAY_TOKENS", "2000");
    vi.stubEnv("JARVIS_CHAT_SEED_BUDGET_TOKENS", "100");
    const { manager, engine, requestConversationSummary, revokeMcpToken } = setup(turns(40, 400));
    const launch = manager.ensureSession("u1", "Ben");
    await expect(launch).rejects.toBeInstanceOf(CliChatUnavailableError);
    await expect(launch).rejects.toThrow(/too long to resume/);
    expect(engine.launchOpts).toBeNull();
    expect(engine.killed).toBe(true);
    expect(revokeMcpToken).toHaveBeenCalled();
    expect(requestConversationSummary).toHaveBeenCalledWith("u1", { threadId }, expect.any(String));
  });

  it("still refuses when the condense request itself fails", async () => {
    vi.stubEnv("JARVIS_CHAT_REPLAY_TOKENS", "2000");
    const { manager, engine, requestConversationSummary } = setup(turns(40, 400));
    requestConversationSummary.mockRejectedValue(new Error("queue down"));
    await expect(manager.ensureSession("u1", "Ben")).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );
    expect(engine.killed).toBe(true);
    expect(engine.launchOpts).toBeNull();
  });
});
