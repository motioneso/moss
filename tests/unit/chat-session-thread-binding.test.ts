import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionTokenRegistry } from "@moss/ai";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { ChatSessionManagerDeps } from "../../packages/chat/src/live/chat-session-ports.js";
import { buildClassifierGateRunner } from "../../packages/chat/src/live/classifier-gate-runner.js";
import {
  createClassifierGateShadowRunner,
  type ClassifierGateShadowRunner
} from "../../packages/chat/src/live/classifier-gate-shadow.js";
import { ClassifierGate } from "../../packages/chat/src/live/classifier-gate.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<ChatSessionManagerDeps> = {}) {
  let currentThreadId: string | null = "thread-A";
  const tokens = new SessionTokenRegistry();
  const engine: CliChatEngine = {
    provider: "anthropic",
    launch: vi.fn(async () => ({ offset: 0 })),
    submit: vi.fn(async () => {}),
    readNew: vi.fn(async () => ({
      records: [{ kind: "reply" as const, text: "Done." }],
      offset: 1,
      complete: true
    })),
    isAlive: vi.fn(async () => true),
    kill: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {})
  };
  const persistence = {
    resolveActiveProvider: vi.fn(async () => ({
      provider: "anthropic" as const,
      model: "test-model"
    })),
    listPriorTurns: vi.fn(async () => ({ recent: [], oldSummary: null })),
    recordTurn: vi.fn(async () => undefined),
    openNewConversation: vi.fn(async () => {
      currentThreadId = "new-thread";
    }),
    getCurrentThreadState: vi.fn(async () =>
      currentThreadId === null ? undefined : { id: currentThreadId, incognito: false }
    ),
    getThreadContext: vi.fn(async () => ({
      threadTitle: null,
      localTimezone: null,
      incognito: false
    })),
    touchExistingThread: vi.fn(async (_actor: string, threadId: string) => {
      currentThreadId = threadId;
      return true;
    })
  };
  const mintMcpToken = vi.fn(
    async (actorUserId: string, chatSessionId: string, threadId: string | null) => ({
      token: tokens.mint({ actorUserId, chatSessionId, threadId, allowedToolNames: null }),
      mcpServerUrl: "http://mcp.test/api/mcp"
    })
  );
  const engineFactory = vi.fn(() => engine);
  const deps: ChatSessionManagerDeps = {
    persistence,
    engineFactory,
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    persona: "Moss",
    clock: { now: () => 0 },
    idleMs: 60_000,
    neutralBase: "/tmp/test-chat-binding",
    pollMs: 0,
    mintMcpToken,
    revokeMcpToken: (sessionKey) => tokens.revokeBySessionId(sessionKey),
    ...overrides
  };
  return {
    manager: new ChatSessionManager(deps),
    engine,
    engineFactory,
    persistence,
    tokens,
    mintMcpToken,
    deps,
    setThread: (threadId: string | null) => {
      currentThreadId = threadId;
    }
  };
}

/** Hold resume between changing the current-thread pointer and stopping the old turn. */
function holdResume(h: ReturnType<typeof harness>) {
  const release = deferred<void>();
  h.persistence.touchExistingThread.mockImplementation(async (_actor, threadId) => {
    h.setThread(threadId);
    await release.promise;
    return true;
  });
  return release;
}

afterEach(() => vi.restoreAllMocks());

describe("chat conversation identity binding", () => {
  it("stops during verified-unavailable healing without canceling shared replacement warmup", async () => {
    const launching = deferred<void>();
    const released = deferred<void>();
    const h = harness();
    await h.manager.ensureSession("owner", "Owner");
    vi.mocked(h.engine.submit).mockRejectedValue(
      new CliChatUnavailableError("verified pre-entry failure")
    );
    const replacement = {
      ...h.engine,
      launch: vi.fn(async () => {
        launching.resolve();
        await released.promise;
        return { offset: 0 };
      }),
      submit: vi.fn(async () => {}),
      kill: vi.fn(async () => {})
    };
    h.engineFactory.mockReturnValue(replacement);
    let reply: string | undefined;
    const turn = h.manager
      .submitTurn("owner", "Owner", "Cancel this healing wait")
      .then((result) => {
        reply = result.reply;
      });
    await launching.promise;
    const prestart = h.manager.ensureSession("owner", "Owner");
    try {
      await h.manager.stopTurn("owner");
      await vi.waitFor(() => expect(reply).toBe(""), { timeout: 100 });
      expect(h.engine.submit).toHaveBeenCalledTimes(1);
      expect(replacement.submit).not.toHaveBeenCalled();
      expect(h.persistence.recordTurn).not.toHaveBeenCalled();
      expect(replacement.kill).not.toHaveBeenCalled();
      const next = h.manager.submitTurn("owner", "Owner", "The healing wait released its lock");
      await h.manager.stopTurn("owner");
      expect(await next).toEqual({ reply: "" });
    } finally {
      released.resolve();
      await Promise.all([prestart, turn]);
    }
    expect((await prestart).threadId).toBe("thread-A");
    expect(replacement.launch).toHaveBeenCalledTimes(1);
    expect(replacement.submit).not.toHaveBeenCalled();
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
  });

  it("stops a turn waiting on shared prestart without canceling the shared engine launch", async () => {
    const launching = deferred<void>();
    const released = deferred<void>();
    const h = harness();
    vi.mocked(h.engine.launch).mockImplementation(async () => {
      launching.resolve();
      await released.promise;
      return { offset: 0 };
    });
    const prestart = h.manager.ensureSession("owner", "Owner");
    await launching.promise;
    let reply: string | undefined;
    const turn = h.manager
      .submitTurn("owner", "Owner", "Cancel only this waiting turn")
      .then((result) => {
        reply = result.reply;
      });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await h.manager.stopTurn("owner");
      await vi.waitFor(() => expect(reply).toBe(""), { timeout: 100 });
      expect(h.engine.submit).not.toHaveBeenCalled();
      expect(h.persistence.recordTurn).not.toHaveBeenCalled();
      expect(h.engine.kill).not.toHaveBeenCalled();
      const next = h.manager.submitTurn("owner", "Owner", "The shared wait released its lock");
      await h.manager.stopTurn("owner");
      expect(await next).toEqual({ reply: "" });
    } finally {
      released.resolve();
      await Promise.all([prestart, turn]);
    }
    expect((await prestart).threadId).toBe("thread-A");
    expect(h.engine.launch).toHaveBeenCalledTimes(1);
    expect(h.engine.submit).not.toHaveBeenCalled();
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
  });

  it("preserves a persistence failure when Stop races with the save", async () => {
    const recording = deferred<void>();
    const released = deferred<void>();
    const failure = new Error("save failed independently of cancellation");
    const h = harness();
    h.persistence.recordTurn.mockImplementation(async () => {
      recording.resolve();
      await released.promise;
      throw failure;
    });
    const turn = h.manager.submitTurn("owner", "Owner", "Preserve this save error");
    await recording.promise;
    await h.manager.stopTurn("owner");
    released.resolve();
    await expect(turn).rejects.toBe(failure);
  });

  it("stops when resume begins during provider validation before the later selection retry", async () => {
    const validating = deferred<void>();
    const providerReleased = deferred<void>();
    const killing = deferred<void>();
    const killReleased = deferred<void>();
    const h = harness();
    await h.manager.ensureSession("owner", "Owner");
    h.persistence.resolveActiveProvider.mockImplementationOnce(async () => {
      validating.resolve();
      await providerReleased.promise;
      return { provider: "anthropic", model: "test-model" };
    });
    vi.mocked(h.engine.kill).mockImplementation(async () => {
      killing.resolve();
      await killReleased.promise;
    });
    let reply: string | undefined;
    const turn = h.manager
      .submitTurn("owner", "Owner", "Cancel this late selection wait")
      .then((result) => {
        reply = result.reply;
      });
    await validating.promise;
    const resume = h.manager.resumeThread("owner", "thread-B");
    await killing.promise;
    try {
      providerReleased.resolve();
      await h.manager.stopTurn("owner");
      await vi.waitFor(() => expect(reply).toBe(""), { timeout: 100 });
      expect(h.engine.submit).not.toHaveBeenCalled();
      expect(h.persistence.recordTurn).not.toHaveBeenCalled();
      const next = h.manager.submitTurn("owner", "Owner", "The canceled turn released its lock");
      await h.manager.stopTurn("owner");
      expect(await next).toEqual({ reply: "" });
      expect(h.engine.submit).not.toHaveBeenCalled();
      expect(h.persistence.recordTurn).not.toHaveBeenCalled();
    } finally {
      providerReleased.resolve();
      killReleased.resolve();
      await Promise.all([resume, turn]);
    }
  });

  it("stops a turn waiting for resume without waiting for the retiring engine", async () => {
    const killing = deferred<void>();
    const released = deferred<void>();
    const h = harness();
    await h.manager.ensureSession("owner", "Owner");
    vi.mocked(h.engine.kill).mockImplementation(async () => {
      killing.resolve();
      await released.promise;
    });
    const resume = h.manager.resumeThread("owner", "thread-B");
    await killing.promise;
    let reply: string | undefined;
    const turn = h.manager
      .submitTurn("owner", "Owner", "Cancel this waiting turn")
      .then((result) => {
        reply = result.reply;
      });
    try {
      await h.manager.stopTurn("owner");
      await vi.waitFor(() => expect(reply).toBe(""), { timeout: 100 });
      expect(h.engine.submit).not.toHaveBeenCalled();
      expect(h.persistence.recordTurn).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await Promise.all([resume, turn]);
    }
  });

  it("waits for an overlapping resume before submitting the next turn to its selected engine", async () => {
    const killing = deferred<void>();
    const released = deferred<void>();
    const h = harness();
    const fresh = {
      ...h.engine,
      submit: vi.fn(async () => {}),
      kill: vi.fn(async () => {})
    };
    await h.manager.ensureSession("owner", "Owner");
    vi.mocked(h.engine.kill).mockImplementation(async () => {
      killing.resolve();
      await released.promise;
    });
    vi.mocked(h.engine.submit).mockRejectedValue(new Error("retiring transport"));
    h.engineFactory.mockReturnValue(fresh);
    h.engineFactory.mockClear();
    h.deps.persistence.getMainThreadState = async () => ({ id: "thread-A", incognito: false });
    h.persistence.listPriorTurns.mockClear();
    const resume = h.manager.resumeThread("owner", "thread-B");
    await killing.promise;
    const prestart = h.manager.ensureSession("owner", "Owner");
    const turn = h.manager.submitTurn("owner", "Owner", "Continue the selected chat");
    const result = turn.catch((error: unknown) => error);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.engine.submit).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await resume;
    }
    expect(await result).toEqual({ reply: "Done." });
    expect((await prestart).threadId).toBe("thread-B");
    expect(h.engineFactory).toHaveBeenCalledExactlyOnceWith(
      "anthropic",
      "owner:drawer",
      expect.objectContaining({ conversationId: "thread-B" })
    );
    expect(h.persistence.listPriorTurns).toHaveBeenCalledExactlyOnceWith(
      "owner",
      { forceReplay: true, threadId: "thread-B" },
      "drawer"
    );
    expect(fresh.submit).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Continue the selected chat")
    );
    expect(h.persistence.recordTurn).toHaveBeenCalledWith(
      "owner",
      "Continue the selected chat",
      "Done.",
      expect.anything(),
      expect.objectContaining({ threadId: "thread-B" }),
      "drawer"
    );
  });

  it("keeps New chat chosen during awaited Main launch validation (#3125)", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const h = harness();
    let reads = 0;
    h.deps.persistence.getMainThreadState = async () => {
      if (++reads === 2) {
        entered.resolve();
        await release.promise;
      }
      return { id: "thread-A", incognito: false };
    };
    const prestart = h.manager.ensureSession("user-1", "Ben");
    await entered.promise;
    await h.manager.clear("user-1");
    release.resolve();
    expect((await prestart).threadId).toBe("new-thread");
    expect((await h.manager.ensureSession("user-1", "Ben")).threadId).toBe("new-thread");
    expect(await h.manager.submitTurn("user-1", "Ben", "Keep my new chat")).toMatchObject({
      reply: "Done."
    });
  });

  it("honors New chat chosen during a cold Main stream launch (#3125)", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const h = harness();
    h.deps.persistence.getMainThreadState = async () => ({ id: "thread-A", incognito: false });
    vi.mocked(h.engine.launch).mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { offset: 0 };
    });
    const prestart = h.manager.ensureSession("user-1", "Ben");
    await started.promise;
    await h.manager.clear("user-1");
    release.resolve();
    expect((await prestart).threadId).toBe("new-thread");
    expect(await h.manager.submitTurn("user-1", "Ben", "My new conversation")).toMatchObject({
      reply: "Done."
    });
  });

  it("keeps the first side turn bound while its stream pre-start is still launching (#3125)", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const readMode = vi.fn(async () => "off" as const);
    const h = harness({
      classifierGate: buildClassifierGateRunner({ readMode, tokens: new SessionTokenRegistry() })
    });
    h.deps.persistence.getMainThreadState = async () => ({ id: "thread-A", incognito: false });
    vi.mocked(h.engine.launch).mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { offset: 0 };
    });
    await h.manager.clear("user-1");
    const prestart = h.manager.ensureSession("user-1", "Ben");
    await started.promise;
    const turn = h.manager.submitTurn("user-1", "Ben", "First side message");
    await vi.waitFor(() => expect(readMode).toHaveBeenCalledOnce());
    release.resolve();
    expect((await prestart).threadId).toBe("new-thread");
    expect(await turn).toMatchObject({ reply: "Done." });
    expect(h.persistence.recordTurn).toHaveBeenCalledWith(
      "user-1",
      "First side message",
      "Done.",
      expect.anything(),
      expect.objectContaining({ threadId: "new-thread" }),
      "drawer"
    );
  });

  it("preserves the old launch binding but returns a fresh session after resume during persona await", async () => {
    const persona = deferred<string>();
    const render = vi.fn(() => persona.promise);
    const h = harness({ persona: render });
    const mintedOrigins: Array<string | null | undefined> = [];
    const mint = h.tokens.mint.bind(h.tokens);
    vi.spyOn(h.tokens, "mint").mockImplementation((context, options) => {
      const token = mint(context, options);
      mintedOrigins.push(h.tokens.verify(token).threadId);
      return token;
    });
    const releaseResume = holdResume(h);
    const launch = h.manager.ensureSession("user-1", "Ben");
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const resume = h.manager.resumeThread("user-1", "thread-B");
    persona.resolve("Moss");
    releaseResume.resolve();
    await resume;
    const session = await launch;

    expect(mintedOrigins).toEqual(["thread-A", "thread-B"]);
    expect(session.threadId).toBe("thread-B");
    expect(h.tokens.verify(session.mcpToken!).threadId).toBe("thread-B");
    expect(h.engine.kill).toHaveBeenCalledOnce();
    expect(h.mintMcpToken).toHaveBeenCalledWith("user-1", "user-1:drawer", "thread-A");
    expect(h.engineFactory).toHaveBeenCalledWith(
      "anthropic",
      "user-1:drawer",
      expect.objectContaining({ conversationId: "thread-A" })
    );
    expect(h.persistence.listPriorTurns).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ threadId: "thread-A" }),
      "drawer"
    );
  });

  it("binds a newly opened conversation and leaves an unavailable identity null", async () => {
    const fresh = harness();
    fresh.setThread(null);
    const freshSession = await fresh.manager.ensureSession("user-1", "Ben");
    expect(fresh.tokens.verify(freshSession.mcpToken!).threadId).toBe("new-thread");

    const missing = harness();
    const manager = new ChatSessionManager({
      ...missing.deps,
      persistence: { ...missing.persistence, getCurrentThreadState: undefined }
    });
    const unbound = await manager.ensureSession("user-1", "Ben");
    expect(unbound.threadId).toBeNull();
    expect(missing.tokens.verify(unbound.mcpToken!).threadId).toBeNull();
    expect(missing.persistence.listPriorTurns).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ threadId: null }),
      "drawer"
    );
  });

  it("keeps the gate token on A and refuses B's model after a same-privacy resume during mode await", async () => {
    const mode = deferred<"on">();
    const gateTokens = new SessionTokenRegistry();
    const mint = vi.spyOn(gateTokens, "mint");
    const readMode = vi.fn(() => mode.promise);
    const gate = buildClassifierGateRunner({ readMode, tokens: gateTokens });
    const evaluate = vi.spyOn(gate, "evaluate");
    const h = harness({ classifierGate: gate });
    const releaseResume = holdResume(h);
    const turn = h.manager.submitTurn("user-1", "Ben", "Do the thing");
    await vi.waitFor(() => expect(readMode).toHaveBeenCalledOnce());
    const resume = h.manager.resumeThread("user-1", "thread-B");
    mode.resolve("on");
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce());
    releaseResume.resolve();
    await resume;
    expect(await turn).toEqual({ reply: "" });

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-A", incognito: false })
    );
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-A" }),
      expect.any(Object)
    );
    expect(h.engine.submit).not.toHaveBeenCalled();
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
  });

  it("keeps missing gate and shadow identities null even when launch creates a thread", async () => {
    const tokens = new SessionTokenRegistry();
    const mint = vi.spyOn(tokens, "mint");
    const gate = buildClassifierGateRunner({ readMode: async () => "on", tokens });
    const shadow: ClassifierGateShadowRunner = {
      start: vi.fn(),
      observeModelTool: vi.fn(),
      noModelTool: vi.fn(),
      cancelTurn: vi.fn()
    };
    const h = harness({ classifierGate: gate, classifierGateShadow: shadow });
    h.setThread(null);
    expect(await h.manager.submitTurn("user-1", "Ben", "Hello")).toEqual({ reply: "Done." });
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null }),
      expect.any(Object)
    );
    expect(shadow.start).toHaveBeenCalledWith(expect.objectContaining({ threadId: null }));
    expect(h.mintMcpToken).toHaveBeenCalledWith("user-1", "user-1:drawer", "new-thread");
  });

  it("keeps shadow requests and tokens bound to A across a resume during its own mode await", async () => {
    const mode = deferred<"shadow">();
    const readMode = vi.fn(() => mode.promise);
    const tokens = new SessionTokenRegistry();
    const complete = vi.fn(async () => true);
    const evaluate = vi.spyOn(ClassifierGate.prototype, "evaluate");
    const identities: Array<string | null> = [];
    const shadow = createClassifierGateShadowRunner({
      readMode,
      createPorts: (_actor, token) => {
        identities.push(tokens.verify(token).threadId);
        return {
          classifier: { resolve: async () => null, choose: vi.fn(), extract: vi.fn() },
          listTools: async () => [],
          loadCandidates: vi.fn(),
          isReleased: () => false,
          gateway: { call: vi.fn() }
        };
      },
      tokens: {
        mint: (actorUserId, correlationId, threadId, allowedToolNames) =>
          tokens.mint({ actorUserId, chatSessionId: correlationId, threadId, allowedToolNames }),
        revoke: (correlationId) => tokens.revokeBySessionId(correlationId)
      },
      repository: { open: vi.fn(async () => true), complete, observeModelTool: vi.fn() } as never,
      dataContext: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      listToolNames: async () => [],
      thresholdVersion: "v1",
      now: () => 0
    });
    const h = harness({ classifierGateShadow: shadow });
    const releaseResume = holdResume(h);
    const turn = h.manager.submitTurn("user-1", "Ben", "Hello");
    await vi.waitFor(() => expect(readMode).toHaveBeenCalledOnce());
    const resume = h.manager.resumeThread("user-1", "thread-B");
    mode.resolve("shadow");
    await turn;
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(identities).toEqual(["thread-A"]);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-A", mode: "shadow" })
    );
    releaseResume.resolve();
    await resume;
  });

  it("persists the model reply with its session binding after current changes during the engine read", async () => {
    const h = harness();
    vi.mocked(h.engine.readNew).mockImplementationOnce(async () => {
      h.setThread("thread-B");
      return { records: [{ kind: "reply", text: "Done." }], offset: 1, complete: true };
    });
    await h.manager.submitTurn("user-1", "Ben", "Hello");
    expect(h.persistence.recordTurn).toHaveBeenCalledWith(
      "user-1",
      "Hello",
      "Done.",
      expect.any(Object),
      expect.objectContaining({ threadId: "thread-A" }),
      "drawer"
    );
  });

  it("persists a gate reply with the original request binding after current changes during evaluation", async () => {
    const recordHandledTurn = vi.fn(async () => ({
      userMessageId: "user-message",
      assistantMessageId: "reply-message"
    }));
    const h = harness();
    const manager = new ChatSessionManager({
      ...h.deps,
      persistence: { ...h.persistence, recordHandledTurn },
      classifierGate: {
        mode: async () => "on",
        evaluate: async () => {
          h.setThread("thread-B");
          return { kind: "handled", reply: "Done.", trace: { risk: "read", latencyMs: 0 } };
        }
      }
    });
    await manager.submitTurn("user-1", "Ben", "Hello");
    expect(recordHandledTurn).toHaveBeenCalledWith(
      "user-1",
      "Hello",
      "Done.",
      expect.any(Object),
      expect.objectContaining({ threadId: "thread-A" }),
      "drawer"
    );
  });

  it("refuses a same-privacy thread switch during a failed-submit relaunch", async () => {
    const h = harness();
    vi.mocked(h.engine.submit).mockImplementationOnce(async () => {
      h.setThread("thread-B");
      throw new CliChatUnavailableError("session gone before delivery");
    });
    expect(await h.manager.submitTurn("user-1", "Ben", "Do the thing")).toEqual({ reply: "" });
    expect(h.engine.submit).toHaveBeenCalledTimes(1);
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
  });
});
