import { describe, expect, it, vi } from "vitest";

import {
  ChatSessionManager,
  type ChatSessionManagerDeps
} from "../../packages/chat/src/live/chat-session-manager.js";
import {
  ApiKeyUnreadableError,
  ChatProviderChangedError,
  UnsupportedApiKeyChatProviderError
} from "../../packages/chat/src/live/errors.js";
import { assertProviderIdentityForPendingTurn } from "../../packages/chat/src/live/chat-session-provider-identity.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

describe("ChatSessionManager provider identity", () => {
  const KEY = "sk-test-never-echo-0004";
  const NEW_KEY = "localproxy0006neverlog";
  const apiKeyProvider = {
    provider: "anthropic",
    model: "claude-test-model",
    providerConfigId: "provider-1",
    authMethod: "api_key",
    acpAgentId: null,
    providerConfigRevision: "rev-1"
  } as const;
  type TestCredential = { apiKey: string; baseUrl: string | null; revision: string };

  function apiKeyManager(credential: TestCredential | null) {
    const engine = new FakeEngine(0);
    const engineFactory = vi.fn(() => engine);
    const deps = makeMinimalDeps({ engineFactory });
    const resolveChatCredential = vi.fn().mockResolvedValue(credential);
    const persistence = {
      ...deps.persistence,
      resolveChatCredential,
      getCurrentThreadState: vi.fn().mockResolvedValue(null)
    };
    vi.mocked(persistence.resolveActiveProvider).mockResolvedValue(apiKeyProvider);
    const manager = new ChatSessionManager({ ...deps, persistence });
    return { manager, engine, engineFactory, persistence, resolveChatCredential };
  }

  it("refuses an API-key row whose key cannot be read, before any conversation or engine", async () => {
    const { manager, engineFactory, persistence } = apiKeyManager(null);
    await expect(manager.ensureSession("u1", "Ada")).rejects.toBeInstanceOf(ApiKeyUnreadableError);
    expect(engineFactory).not.toHaveBeenCalled();
    expect(persistence.openNewConversation).not.toHaveBeenCalled();
  });

  it("launches an API-key row with its key, address and model", async () => {
    const { manager, engineFactory, resolveChatCredential } = apiKeyManager({
      apiKey: KEY,
      baseUrl: "http://proxy.test",
      revision: "rev-1"
    });
    await manager.ensureSession("u1", "Ada");
    expect(resolveChatCredential).toHaveBeenCalledWith("u1", "provider-1");
    expect(engineFactory).toHaveBeenCalledWith(
      "anthropic",
      "u1:drawer",
      expect.objectContaining({
        authMethod: "api_key",
        credential: { apiKey: KEY, baseUrl: "http://proxy.test", model: "claude-test-model" }
      })
    );
  });

  it("keeps the key out of logs, stored calls and the agent's input", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    try {
      const { manager, engine, persistence } = apiKeyManager({
        apiKey: KEY,
        baseUrl: null,
        revision: "rev-1"
      });
      await manager.ensureSession("u1", "Ada");
      const storedCalls = Object.entries(persistence)
        .filter(([name]) => name !== "resolveChatCredential")
        .map(([, fn]) => vi.mocked(fn).mock.calls);
      expect(JSON.stringify(logged)).not.toContain(KEY);
      expect(JSON.stringify(storedCalls)).not.toContain(KEY);
      expect(JSON.stringify(engine.submitted)).not.toContain(KEY);
      expect(JSON.stringify(engine.launchOpts)).not.toContain(KEY);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    ["a new key", { apiKey: NEW_KEY, baseUrl: "http://proxy.test" }],
    ["a new address", { apiKey: KEY, baseUrl: "http://proxy.test/other" }]
  ])("discards the engine and relaunches when the same row gets %s", async (_label, next) => {
    const engines: FakeEngine[] = [];
    const engineFactory = vi.fn(() => {
      const engine = new FakeEngine(0);
      engines.push(engine);
      return engine;
    });
    const deps = makeMinimalDeps({ engineFactory });
    let revision = "rev-1";
    let credential: TestCredential = { apiKey: KEY, baseUrl: "http://proxy.test", revision };
    const persistence = {
      ...deps.persistence,
      resolveChatCredential: vi.fn(async () => credential),
      getCurrentThreadState: vi.fn().mockResolvedValue(null)
    };
    vi.mocked(persistence.resolveActiveProvider).mockImplementation(async () => ({
      ...apiKeyProvider,
      providerConfigRevision: revision
    }));
    const manager = new ChatSessionManager({ ...deps, persistence });

    await manager.ensureSession("u1", "Ada");
    revision = "rev-2";
    credential = { ...next, revision };
    await manager.ensureSession("u1", "Ada");

    expect(engines).toHaveLength(2);
    expect(engines[0]?.killed).toBe(true);
    expect(engineFactory).toHaveBeenLastCalledWith(
      "anthropic",
      "u1:drawer",
      expect.objectContaining({ credential: { ...next, model: "claude-test-model" } })
    );
  });

  it("retries with the new row when the key changes between the provider read and the key read", async () => {
    const { manager, engineFactory, persistence, resolveChatCredential } = apiKeyManager(null);
    vi.mocked(persistence.resolveActiveProvider)
      .mockResolvedValueOnce(apiKeyProvider)
      .mockResolvedValue({ ...apiKeyProvider, providerConfigRevision: "rev-2" });
    resolveChatCredential.mockResolvedValue({ apiKey: NEW_KEY, baseUrl: null, revision: "rev-2" });

    await manager.ensureSession("u1", "Ada");

    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(engineFactory).toHaveBeenCalledWith(
      "anthropic",
      "u1:drawer",
      expect.objectContaining({
        credential: { apiKey: NEW_KEY, baseUrl: null, model: "claude-test-model" }
      })
    );
  });

  it("refuses a pending turn once the row's key or address changed", async () => {
    await expect(
      assertProviderIdentityForPendingTurn(apiKeyProvider, {
        ...apiKeyProvider,
        providerConfigRevision: "rev-2"
      })
    ).rejects.toBeInstanceOf(ChatProviderChangedError);
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

  it("evicts a cached CLI engine when the provider changes to an unsupported API-key kind", async () => {
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
    const googleKey = {
      ...cliProvider,
      provider: "google",
      authMethod: "api_key",
      acpAgentId: null
    } as const;
    let activeProvider: typeof cliProvider | typeof googleKey = cliProvider;
    vi.mocked(deps.persistence.resolveActiveProvider).mockImplementation(
      async () => activeProvider
    );
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ada");
    activeProvider = googleKey;
    await expect(manager.ensureSession("u1", "Ada")).rejects.toBeInstanceOf(
      UnsupportedApiKeyChatProviderError
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

  it("does not emit or submit a prepared turn after the active provider changes", async () => {
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
    let retrievalStarted!: () => void;
    let releaseRetrieval!: (value: string) => void;
    const retrievalStartedPromise = new Promise<void>((resolve) => {
      retrievalStarted = resolve;
    });
    const deferredRetrieval = new Promise<string>((resolve) => {
      releaseRetrieval = resolve;
    });
    const engineFactory = vi.fn<ChatSessionManagerDeps["engineFactory"]>();
    engineFactory.mockReturnValueOnce(oldEngine).mockReturnValueOnce(newEngine);
    const deps = makeMinimalDeps({
      engineFactory,
      serverOwnsDrain: true,
      pollMs: 0,
      passiveRetrieval: {
        retrieve: vi.fn(() => {
          retrievalStarted();
          return deferredRetrieval;
        })
      },
      persistence: {
        resolveActiveProvider: vi.fn().mockImplementation(async () => activeProvider),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      }
    });
    const manager = new ChatSessionManager(deps as never);
    const emitted: { kind?: string; text?: string }[] = [];
    manager.subscribe("u1", (record) => emitted.push(record));
    const turn = manager.submitTurn("u1", "Ben", "prepared for Codex");

    await retrievalStartedPromise;
    activeProvider = openCode;
    await manager.switchProvider("u1", "Ben");
    releaseRetrieval("");

    await expect(turn).rejects.toMatchObject({ name: "ChatProviderChangedError" });
    expect(oldEngine.submitted).toEqual([]);
    expect(newEngine.submitted).toEqual([]);
    expect(emitted).not.toContainEqual(
      expect.objectContaining({ kind: "user", text: "prepared for Codex" })
    );
  });
});
