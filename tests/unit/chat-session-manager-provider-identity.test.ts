import { describe, expect, it, vi } from "vitest";

import {
  ChatSessionManager,
  type ChatSessionManagerDeps
} from "../../packages/chat/src/live/chat-session-manager.js";
import {
  ApiKeyLiveChatUnavailableError,
  CliChatUnavailableError
} from "../../packages/chat/src/live/errors.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

describe("ChatSessionManager provider identity", () => {
  it("rejects API-key live chat before creating or launching an engine", async () => {
    const engineFactory = vi.fn(() => new FakeEngine(0));
    const deps = makeMinimalDeps({ engineFactory });
    vi.mocked(deps.persistence.resolveActiveProvider).mockResolvedValue({
      provider: "openai-compatible",
      model: "gpt-5.6",
      authMethod: "api_key",
      acpAgentId: null
    });
    const manager = new ChatSessionManager(deps);

    await expect(manager.ensureSession("u1", "Ben")).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );
    expect(engineFactory).not.toHaveBeenCalled();
    expect(deps.persistence.openNewConversation).not.toHaveBeenCalled();
  });

  it("relaunches a cached session when the ACP agent changes and replays the conversation", async () => {
    const oldEngine = new FakeEngine(0);
    const newEngine = new FakeEngine(0);
    const engineFactory = vi.fn().mockReturnValueOnce(oldEngine).mockReturnValueOnce(newEngine);
    const deps = makeMinimalDeps({ engineFactory });
    const codex = {
      provider: "openai-compatible",
      model: "gpt-5.6",
      providerConfigId: "provider-1",
      authMethod: "cli",
      acpAgentId: "codex-acp",
      executionMode: "non_interactive"
    } as const;
    const openCode = { ...codex, acpAgentId: "opencode" } as const;
    let activeProvider: typeof codex | typeof openCode = codex;
    vi.mocked(deps.persistence.resolveActiveProvider).mockImplementation(
      async () => activeProvider
    );
    vi.mocked(deps.persistence.listPriorTurns)
      .mockResolvedValueOnce({ recent: [], oldSummary: null })
      .mockResolvedValueOnce({
        recent: [{ role: "user", content: "previous turn" }],
        oldSummary: null
      });
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ben");
    activeProvider = openCode;
    const refreshed = await manager.ensureSession("u1", "Ben");

    expect(oldEngine.killed).toBe(true);
    expect(refreshed.engine).toBe(newEngine);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    expect(engineFactory).toHaveBeenLastCalledWith(
      "openai-compatible",
      "u1:drawer",
      expect.objectContaining({ acpAgentId: "opencode" })
    );
    expect(newEngine.submitted.some((text) => text.includes("previous turn"))).toBe(true);
  });

  it("evicts a cached CLI engine when the provider changes to API-key auth", async () => {
    const oldEngine = new FakeEngine(0);
    const engineFactory = vi.fn(() => oldEngine);
    const deps = makeMinimalDeps({ engineFactory });
    const cliProvider = {
      provider: "openai-compatible",
      model: "gpt-5.6",
      providerConfigId: "provider-1",
      authMethod: "cli",
      acpAgentId: "codex-acp",
      executionMode: "non_interactive"
    } as const;
    const apiKeyProvider = { ...cliProvider, authMethod: "api_key", acpAgentId: null } as const;
    let activeProvider: typeof cliProvider | typeof apiKeyProvider = cliProvider;
    vi.mocked(deps.persistence.resolveActiveProvider).mockImplementation(
      async () => activeProvider
    );
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ben");
    activeProvider = apiKeyProvider;
    await expect(manager.ensureSession("u1", "Ben")).rejects.toBeInstanceOf(
      ApiKeyLiveChatUnavailableError
    );

    expect(oldEngine.killed).toBe(true);
    expect(engineFactory).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unsupported legacy CLI provider with setup remediation", async () => {
    const engineFactory = vi.fn(() => new FakeEngine(0));
    const deps = makeMinimalDeps({ engineFactory });
    vi.mocked(deps.persistence.resolveActiveProvider).mockResolvedValue({
      provider: "openai-compatible",
      model: "gpt-5.6",
      authMethod: "cli",
      acpAgentId: null
    });
    const manager = new ChatSessionManager(deps);

    await expect(manager.ensureSession("u1", "Ben")).rejects.toThrow(
      "This legacy CLI provider has no supported ACP agent"
    );
    expect(engineFactory).not.toHaveBeenCalled();
  });

  it("does not launch or send replay to Codex when identity changes during deferred engine creation", async () => {
    const oldEngine = new FakeEngine(0);
    const newEngine = new FakeEngine(0);
    const codex = {
      provider: "openai-compatible",
      model: "gpt-5.6",
      providerConfigId: "provider-1",
      authMethod: "cli",
      acpAgentId: "codex-acp",
      executionMode: "non_interactive"
    } as const;
    const openCode = { ...codex, acpAgentId: "opencode" } as const;
    let activeProvider: typeof codex | typeof openCode = codex;
    let signalFactoryStarted!: () => void;
    let releaseFactory!: (engine: FakeEngine) => void;
    const factoryStarted = new Promise<void>((resolve) => {
      signalFactoryStarted = resolve;
    });
    const deferredEngine = new Promise<FakeEngine>((resolve) => {
      releaseFactory = resolve;
    });
    const engineFactory = vi.fn<ChatSessionManagerDeps["engineFactory"]>();
    engineFactory
      .mockImplementationOnce(() => {
        signalFactoryStarted();
        return deferredEngine;
      })
      .mockImplementationOnce(() => newEngine);
    const deps = makeMinimalDeps({ engineFactory });
    vi.mocked(deps.persistence.resolveActiveProvider).mockImplementation(
      async () => activeProvider
    );
    vi.mocked(deps.persistence.listPriorTurns).mockResolvedValue({
      recent: [{ role: "user", content: "previous turn" }],
      oldSummary: null
    });
    const manager = new ChatSessionManager(deps);
    const turn = manager.submitTurn("u1", "Ben", "current turn");

    await factoryStarted;
    activeProvider = openCode;
    releaseFactory(oldEngine);
    await turn;

    expect(oldEngine.killed).toBe(true);
    expect(oldEngine.launchOpts).toBeNull();
    expect(oldEngine.submitted).toEqual([]);
    expect(newEngine.launchOpts?.replayBatch).toContain("previous turn");
    expect(newEngine.submitted.some((text) => text.includes("current turn"))).toBe(true);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    expect(engineFactory).toHaveBeenLastCalledWith(
      "openai-compatible",
      "u1:drawer",
      expect.objectContaining({ acpAgentId: "opencode" })
    );
  });

  it("does not let switchProvider report success with a deferred stale engine", async () => {
    const oldEngine = new FakeEngine(0);
    const newEngine = new FakeEngine(0);
    const codex = {
      provider: "openai-compatible",
      model: "gpt-5.6",
      providerConfigId: "provider-1",
      authMethod: "cli",
      acpAgentId: "codex-acp",
      executionMode: "non_interactive"
    } as const;
    const openCode = { ...codex, acpAgentId: "opencode" } as const;
    let activeProvider: typeof codex | typeof openCode = codex;
    let signalFactoryStarted!: () => void;
    let releaseFactory!: (engine: FakeEngine) => void;
    const factoryStarted = new Promise<void>((resolve) => {
      signalFactoryStarted = resolve;
    });
    const deferredEngine = new Promise<FakeEngine>((resolve) => {
      releaseFactory = resolve;
    });
    const engineFactory = vi.fn<ChatSessionManagerDeps["engineFactory"]>();
    engineFactory
      .mockImplementationOnce(() => {
        signalFactoryStarted();
        return deferredEngine;
      })
      .mockImplementationOnce(() => newEngine);
    const deps = makeMinimalDeps({ engineFactory });
    vi.mocked(deps.persistence.resolveActiveProvider).mockImplementation(
      async () => activeProvider
    );
    const manager = new ChatSessionManager(deps);
    const initial = manager.ensureSession("u1", "Ben");

    await factoryStarted;
    activeProvider = openCode;
    const switching = manager.switchProvider("u1", "Ben");
    releaseFactory(oldEngine);
    const session = await initial;
    await switching;

    expect(session.engine).toBe(newEngine);
    expect(oldEngine.killed).toBe(true);
    expect(oldEngine.launchOpts).toBeNull();
    expect(engineFactory).toHaveBeenCalledTimes(2);
  });
});
