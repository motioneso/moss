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
  it("binds launch to its original thread when resume changes current during persona await", async () => {
    const persona = deferred<string>();
    const render = vi.fn(() => persona.promise);
    const h = harness({ persona: render });
    const releaseResume = holdResume(h);
    const launch = h.manager.ensureSession("user-1", "Ben");
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const resume = h.manager.resumeThread("user-1", "thread-B");
    persona.resolve("Moss");
    const session = await launch;

    expect(session.threadId).toBe("thread-A");
    expect(h.tokens.verify(session.mcpToken!).threadId).toBe("thread-A");
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

    releaseResume.resolve();
    await resume;
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
    releaseResume.resolve();
    await resume;
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
