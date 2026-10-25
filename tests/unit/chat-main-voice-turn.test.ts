import { describe, expect, it, vi } from "vitest";
import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { TranscriptRecord, CliChatEngine } from "../../packages/chat/src/live/types.js";
import {
  ApiKeyUnreadableError,
  UnsupportedApiKeyChatProviderError,
  UnsupportedLegacyCliProviderError
} from "../../packages/chat/src/live/errors.js";

const binding = { threadId: "main", turnId: "reserved-turn" };
function setup(overrides: Partial<ChatSessionManagerDeps> = {}) {
  let selected = { id: "main", incognito: false };
  const engines: CliChatEngine[] = [];
  const persistence: ChatPersistencePort = {
    resolveActiveProvider: async () => ({ provider: "anthropic", model: "test" }),
    getMainThreadState: async () => ({ id: "main", incognito: false }),
    getCurrentThreadState: async () => selected,
    listPriorTurns: async () => ({ recent: [], oldSummary: null }),
    openNewConversation: async () => {},
    touchExistingThread: async (_actor, id) => {
      selected = { id, incognito: id === "private" };
      return true;
    },
    getThreadContext: async () => ({
      threadTitle: null,
      localTimezone: null,
      incognito: selected.incognito
    }),
    recordTurn: vi.fn(async () => ({ userMessageId: "user", assistantMessageId: "reply" }))
  };
  const manager = new ChatSessionManager({
    persistence,
    engineFactory: () => {
      let submitted = false;
      const engine: CliChatEngine = {
        provider: "anthropic",
        handlesOwnPrivatePurge: true,
        launch: vi.fn(async () => ({ offset: 0 })),
        submit: vi.fn(async () => {
          submitted = true;
        }),
        readNew: async (offset) => ({
          records: submitted ? [{ kind: "reply", text: "Reply" }] : [],
          offset: offset + 1,
          complete: submitted
        }),
        isAlive: async () => true,
        kill: vi.fn(async () => {}),
        interrupt: async () => {}
      };
      engines.push(engine);
      return engine;
    },
    clock: { now: () => 0 },
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    neutralBase: "/tmp/voice-unit",
    persona: "Test",
    pollMs: 0,
    idleMs: 0,
    idleWatchdogMs: 0,
    ...overrides
  });
  return { manager, engines, persistence };
}
describe("admitted Main voice turns", () => {
  it("wakes each busy receipt once, in arrival order, after the blocking turn releases", async () => {
    const { manager, persistence } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = persistence.recordTurn;
    persistence.recordTurn = async (...args) => {
      await held;
      return original(...args);
    };
    const blocking = manager.submitTurn("owner", "Owner", "Typed");
    const order: string[] = [];
    const staleRetry = vi.fn(async () => {
      order.push("stale");
    });
    const retry = async () => {
      order.push("first");
    };
    const claim = vi.fn(async () => true);
    for (const [turnId, wake] of [
      ["first", staleRetry],
      ["first", retry],
      [
        "second",
        async () => {
          order.push("second");
        }
      ]
    ] as const) {
      expect(
        await manager.submitMainVoiceTurn(
          "owner",
          "Owner",
          "Voice",
          { ...binding, turnId },
          claim,
          wake
        )
      ).toBe("deferred");
    }
    expect(order).toEqual([]);
    release();
    await blocking;
    await vi.waitFor(() => expect(order).toEqual(["first", "second"]));
    expect(claim).not.toHaveBeenCalled();
    expect(staleRetry).not.toHaveBeenCalled();
  });
  it("does not delay a completed turn while its requeue hint is stalled", async () => {
    const { manager } = setup();
    let release!: (value: boolean) => void;
    let releaseWake!: () => void;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const stalledWake = new Promise<void>((resolve) => {
      releaseWake = resolve;
    });
    const blocking = manager.submitMainVoiceTurn("owner", "Owner", "First", binding, () => held);
    expect(
      await manager.submitMainVoiceTurn(
        "owner",
        "Owner",
        "Second",
        { ...binding, turnId: "second" },
        async () => true,
        () => stalledWake
      )
    ).toBe("deferred");
    release(false);
    try {
      await expect(
        Promise.race([
          blocking,
          new Promise((resolve) => setTimeout(() => resolve("stalled"), 100))
        ])
      ).resolves.toBe("unclaimed");
    } finally {
      releaseWake();
    }
  });
  it("isolates wakeup failures from the completed turn and releases the guard before waking", async () => {
    const { manager } = setup();
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const blocking = manager.submitMainVoiceTurn("owner", "Owner", "First", binding, () => held);
    let nextReply: string | undefined;
    const wake = vi.fn(async () => {
      nextReply = (await manager.submitTurn("owner", "Owner", "Next")).reply;
      throw new Error("queue unavailable");
    });
    expect(
      await manager.submitMainVoiceTurn(
        "owner",
        "Owner",
        "Second",
        { ...binding, turnId: "second" },
        async () => true,
        wake
      )
    ).toBe("deferred");
    release(false);
    expect(await blocking).toBe("unclaimed");
    expect(wake).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(nextReply).toBe("Reply"));
  });

  it.each(["anthropic", "openai-compatible"] as const)(
    "admits a supported %s API-key provider through the ordinary Main turn",
    async (provider) => {
      const { manager, persistence, engines } = setup();
      persistence.resolveActiveProvider = async () => ({
        provider,
        model: "test",
        authMethod: "api_key",
        providerConfigId: "configured-provider",
        providerConfigRevision: "revision"
      });
      persistence.resolveChatCredential = vi.fn(async () => ({
        apiKey: "test-key",
        baseUrl: null,
        revision: "revision"
      }));
      const claim = vi.fn(async () => true);
      await expect(
        manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
      ).resolves.toBe("executed");
      expect(claim).toHaveBeenCalledOnce();
      expect(persistence.resolveChatCredential).toHaveBeenCalledWith(
        "owner",
        "configured-provider"
      );
      expect(engines).toHaveLength(1);
      expect(engines[0]?.submit).toHaveBeenCalledOnce();
      expect(persistence.recordTurn).toHaveBeenCalledOnce();
    }
  );
  it("keeps an unreadable API-key provider queued until its credential recovers", async () => {
    const { manager, persistence, engines } = setup();
    persistence.resolveActiveProvider = async () => ({
      provider: "anthropic",
      model: "test",
      authMethod: "api_key",
      providerConfigId: "configured-provider",
      providerConfigRevision: "revision"
    });
    persistence.resolveChatCredential = vi.fn(async () => null);
    const claim = vi.fn(async () => true);
    await expect(
      manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
    ).rejects.toBeInstanceOf(ApiKeyUnreadableError);
    expect(claim).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
    expect(persistence.recordTurn).not.toHaveBeenCalled();
    persistence.resolveChatCredential = async () => ({
      apiKey: "test-key",
      baseUrl: null,
      revision: "revision"
    });
    await expect(
      manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
    ).resolves.toBe("executed");
    expect(claim).toHaveBeenCalledOnce();
    expect(persistence.recordTurn).toHaveBeenCalledOnce();
  });
  it.each([
    { authMethod: "api_key", error: UnsupportedApiKeyChatProviderError },
    { authMethod: "cli", error: UnsupportedLegacyCliProviderError }
  ] as const)(
    "keeps the claim queued for an unsupported $authMethod provider",
    async ({ authMethod, error }) => {
      const { manager, persistence, engines } = setup();
      persistence.resolveActiveProvider = async () => ({
        provider: "google",
        model: "test",
        authMethod
      });
      const claim = vi.fn(async () => true);
      await expect(
        manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
      ).rejects.toBeInstanceOf(error);
      expect(claim).not.toHaveBeenCalled();
      expect(engines).toHaveLength(0);
      expect(persistence.recordTurn).not.toHaveBeenCalled();
    }
  );
  it("keeps the claim untouched during a known runner outage and can send after recovery", async () => {
    let available = false;
    const assertRuntimeReady = vi.fn(() => {
      if (!available) throw new Error("runner unavailable");
    });
    const { manager, engines } = setup({ assertRuntimeReady });
    const claim = vi.fn(async () => true);
    await expect(
      manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
    ).rejects.toThrow("runner unavailable");
    expect(claim).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
    available = true;
    await expect(
      manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
    ).resolves.toBe("executed");
    expect(claim).toHaveBeenCalledOnce();
  });
  it("does not claim or launch while the configured provider is unavailable", async () => {
    const { manager, persistence, engines } = setup();
    const claim = vi.fn(async () => true);
    persistence.resolveActiveProvider = async () => {
      throw new Error("provider unavailable");
    };
    await expect(
      manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)
    ).rejects.toThrow("provider unavailable");
    expect(claim).not.toHaveBeenCalled();
    expect(engines).toHaveLength(0);
    persistence.resolveActiveProvider = async () => ({ provider: "anthropic", model: "test" });
    expect(await manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)).toBe(
      "executed"
    );
    expect(claim).toHaveBeenCalledOnce();
  });
  it("carries the admitted identity through a classifier-handled action without launching an engine", async () => {
    const gate = {
      mode: vi.fn(async () => "on" as const),
      evaluate: vi.fn(async () => ({
        kind: "handled" as const,
        reply: "Task saved.",
        trace: { moduleId: "tasks", toolName: "tasks.create", risk: "write" as const, latencyMs: 1 }
      }))
    };
    const { manager, persistence, engines } = setup({ classifierGate: gate });
    persistence.recordHandledTurn = vi.fn(async () => ({
      userMessageId: "user",
      assistantMessageId: "reply"
    }));
    const claim = vi.fn(async () => {
      expect(gate.evaluate).not.toHaveBeenCalled();
      return true;
    });
    expect(await manager.submitMainVoiceTurn("owner", "Owner", "Add a task", binding, claim)).toBe(
      "executed"
    );
    expect(gate.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "main", turnId: binding.turnId })
    );
    expect(persistence.recordHandledTurn).toHaveBeenCalledWith(
      "owner",
      "Add a task",
      "Task saved.",
      expect.anything(),
      expect.objectContaining({ threadId: "main", turnId: binding.turnId }),
      "drawer"
    );
    expect(engines).toHaveLength(0);
  });
  it("carries the admitted identity through a reminder without launching an engine", async () => {
    const { manager, persistence, engines } = setup();
    persistence.recordReminderTurn = vi.fn(async () => ({
      userMessageId: "user",
      assistantMessageId: "reply",
      reply: "Reminder set.",
      origin: {
        version: 1 as const,
        kind: "reminder" as const,
        event: "saved" as const,
        reminderId: "reminder"
      }
    }));
    expect(
      await manager.submitMainVoiceTurn(
        "owner",
        "Owner",
        "Remind me in 10 minutes to stretch",
        binding,
        async () => true
      )
    ).toBe("executed");
    expect(persistence.recordReminderTurn).toHaveBeenCalledWith(
      "owner",
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ threadId: "main", turnId: binding.turnId }),
      "drawer"
    );
    expect(engines).toHaveLength(0);
  });
  it("claims before pre-model/model dispatch, persists the fixed turn, and tags live activity", async () => {
    const { manager, persistence } = setup(),
      records: TranscriptRecord[] = [];
    manager.subscribe("owner", (record) => records.push(record));
    const claim = vi.fn(async () => {
      expect(persistence.recordTurn).not.toHaveBeenCalled();
      return true;
    });
    expect(await manager.submitMainVoiceTurn("owner", "Owner", "Voice text", binding, claim)).toBe(
      "executed"
    );
    expect(claim).toHaveBeenCalledTimes(1);
    expect(persistence.recordTurn).toHaveBeenCalledWith(
      "owner",
      "Voice text",
      "Reply",
      expect.anything(),
      expect.objectContaining({ turnId: binding.turnId, threadId: binding.threadId }),
      "drawer"
    );
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.voiceThreadId === "main")).toBe(true);
  });
  it.each(["side", "private"])(
    "defers a %s selection and preserves its warm engine/context",
    async (thread) => {
      const { manager, engines } = setup();
      await manager.resumeThread("owner", thread);
      const original = await manager.ensureSession("owner", "Owner");
      const claim = vi.fn(async () => true);
      expect(await manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)).toBe(
        "deferred"
      );
      expect(claim).not.toHaveBeenCalled();
      expect(engines).toHaveLength(1);
      expect(engines[0]?.kill).not.toHaveBeenCalled();
      expect(await manager.ensureSession("owner", "Owner")).toBe(original);
      expect((await manager.getPrivacyState("owner")).threadId).toBe(thread);
    }
  );
  it("shares the ordinary busy guard while committing the admission", async () => {
    const { manager } = setup();
    let release!: (claimed: boolean) => void;
    const claim = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const first = manager.submitMainVoiceTurn("owner", "Owner", "First", binding, () => claim);
    const secondClaim = vi.fn(async () => true);
    expect(
      await manager.submitMainVoiceTurn("owner", "Owner", "Second", binding, secondClaim)
    ).toBe("deferred");
    await expect(manager.submitTurn("owner", "Owner", "Typed")).rejects.toThrow(
      "already in progress"
    );
    release(false);
    expect(await first).toBe("unclaimed");
    expect(secondClaim).not.toHaveBeenCalled();
    await expect(manager.submitTurn("owner", "Owner", "Typed after")).resolves.toMatchObject({
      reply: "Reply"
    });
  });
  it("refuses a conversation switch during claim before any effects and releases the guard", async () => {
    const { manager, engines, persistence } = setup();
    await expect(
      manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, async () => {
        await manager.resumeThread("owner", "private");
        return true;
      })
    ).rejects.toThrow("Main changed");
    expect(engines).toHaveLength(0);
    expect(persistence.recordTurn).not.toHaveBeenCalled();
    expect((await manager.getPrivacyState("owner")).threadId).toBe("private");
  });
  it("retries as soon as an already-warming session is ready", async () => {
    const { manager, persistence } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    persistence.resolveActiveProvider = async () => {
      await held;
      return { provider: "anthropic", model: "test" };
    };
    const launching = manager.ensureSession("owner", "Owner");
    const claim = vi.fn(async () => true);
    const wake = vi.fn(async () => {});
    expect(await manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim, wake)).toBe(
      "deferred"
    );
    expect(wake).not.toHaveBeenCalled();
    release();
    await launching;
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    expect(claim).not.toHaveBeenCalled();
  });
  it("leaves failed warm launches to delayed recovery without a wake loop", async () => {
    const { manager, persistence } = setup();
    let fail!: (error: Error) => void;
    const held = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    persistence.resolveActiveProvider = () => held;
    const launching = manager.ensureSession("owner", "Owner");
    const wake = vi.fn(async () => {});
    expect(
      await manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, async () => true, wake)
    ).toBe("deferred");
    const failed = expect(launching).rejects.toThrow("unavailable");
    fail(new Error("unavailable"));
    await failed;
    expect(wake).not.toHaveBeenCalled();
    persistence.resolveActiveProvider = async () => ({ provider: "anthropic", model: "test" });
    await manager.ensureSession("owner", "Owner");
    expect(wake).not.toHaveBeenCalled();
  });
  it("does not claim while another engine is launching", async () => {
    const { manager, persistence } = setup();
    let release!: () => void;
    const launchWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    persistence.resolveActiveProvider = async () => {
      await launchWait;
      return { provider: "anthropic", model: "test" };
    };
    const launch = manager.ensureSession("owner", "Owner");
    const claim = vi.fn(async () => true);
    expect(await manager.submitMainVoiceTurn("owner", "Owner", "Voice", binding, claim)).toBe(
      "deferred"
    );
    release();
    await launch;
    expect(claim).not.toHaveBeenCalled();
  });
});
