import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";

// #1081 H2: split out of tests/unit/chat-session-manager.test.ts, which sits at the
// check:file-size 1000-line cap — adding this coverage there pushed it over. Reuses that
// file's `makeMinimalDeps` fixture (exported for exactly this reason) rather than drifting
// a second copy of it.
import { makeMinimalDeps } from "./chat-session-manager.test.js";

describe("ChatSessionManager.dropSessionsForProvider (#1081 H2)", () => {
  /** A minimal fake engine, provider settable per-instance (unlike FakeEngine's fixed "anthropic"). */
  function makeEngine(provider: "anthropic" | "openai-compatible" | "google") {
    return {
      provider,
      launch: vi.fn().mockResolvedValue({ offset: 0 }),
      submit: vi.fn().mockResolvedValue(undefined),
      readNew: vi.fn().mockResolvedValue({ records: [], offset: 0, complete: true }),
      isAlive: vi.fn().mockResolvedValue(true),
      kill: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    };
  }

  function makeMultiProviderManager(revokeMcpToken = vi.fn()) {
    // Two users on "anthropic", one on "openai-compatible" — resolveActiveProvider is keyed
    // by whichever provider makeEngine was constructed with (engineFactory picks the fake for
    // that provider), so ensureSession's persisted "provider" tracks the launched engine.
    const engines = new Map<string, ReturnType<typeof makeEngine>>();
    const persistence = {
      resolveActiveProvider: vi.fn().mockImplementation(async (userId: string) => ({
        provider: userId === "u-codex" ? "openai-compatible" : "anthropic",
        model: "default",
        providerConfigId: `row-${userId}`
      })),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      openNewConversation: vi.fn().mockResolvedValue(undefined),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true)
    };
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: (
          provider: "anthropic" | "openai-compatible" | "google",
          sessionKey: string
        ) => {
          const engine = makeEngine(provider);
          engines.set(sessionKey, engine);
          return engine;
        },
        revokeMcpToken,
        persistence
      })
    );
    return { manager, engines, persistence };
  }

  it("kills + drops every session bound to the given provider, leaving other providers' sessions live", async () => {
    const { manager, engines } = makeMultiProviderManager();
    await manager.ensureSession("u-claude-1", "Alice");
    await manager.ensureSession("u-claude-2", "Bob");
    await manager.ensureSession("u-codex", "Cara");

    await manager.dropSessionsForProvider("anthropic");

    expect(engines.get("u-claude-1:drawer")?.kill).toHaveBeenCalledTimes(1);
    expect(engines.get("u-claude-2:drawer")?.kill).toHaveBeenCalledTimes(1);
    expect(engines.get("u-codex:drawer")?.kill).not.toHaveBeenCalled();

    // The dropped anthropic sessions relaunch (fresh engine) on the next ensureSession — the
    // codex session was never touched, so a fresh ensureSession for it must NOT relaunch.
    const codexEngineBefore = engines.get("u-codex:drawer");
    await manager.ensureSession("u-codex", "Cara");
    expect(engines.get("u-codex:drawer")).toBe(codexEngineBefore); // same engine instance, no relaunch
  });

  it("drops only the sessions bound to the given provider row", async () => {
    const { manager, engines } = makeMultiProviderManager();
    await manager.ensureSession("u-claude-1", "Alice");
    await manager.ensureSession("u-claude-2", "Bob");
    await manager.ensureSession("u-codex", "Cara");

    await manager.dropSessionsForProvider({ providerConfigId: "row-u-claude-1" });

    expect(engines.get("u-claude-1:drawer")?.kill).toHaveBeenCalledTimes(1);
    expect(engines.get("u-claude-2:drawer")?.kill).not.toHaveBeenCalled();
    expect(engines.get("u-codex:drawer")?.kill).not.toHaveBeenCalled();
  });

  it("revokes the MCP token for every dropped session, not for untouched ones", async () => {
    const revokeMcpToken = vi.fn();
    const { manager } = makeMultiProviderManager(revokeMcpToken);
    await manager.ensureSession("u-claude-1", "Alice");
    await manager.ensureSession("u-codex", "Cara");

    await manager.dropSessionsForProvider("anthropic");

    expect(revokeMcpToken).toHaveBeenCalledWith("u-claude-1:drawer");
    expect(revokeMcpToken).not.toHaveBeenCalledWith("u-codex:drawer");
  });

  it("does NOT clear the conversation (no openNewConversation call) — only kill+drop", async () => {
    const { manager, persistence } = makeMultiProviderManager();
    await manager.ensureSession("u-claude-1", "Alice");
    persistence.openNewConversation.mockClear();

    await manager.dropSessionsForProvider("anthropic");

    expect(persistence.openNewConversation).not.toHaveBeenCalled();
  });

  it("is a no-op when no session is bound to the given provider", async () => {
    const { manager, engines } = makeMultiProviderManager();
    await manager.ensureSession("u-codex", "Cara");

    await expect(manager.dropSessionsForProvider("anthropic")).resolves.toBeUndefined();
    expect(engines.get("u-codex:drawer")?.kill).not.toHaveBeenCalled();
  });
});
