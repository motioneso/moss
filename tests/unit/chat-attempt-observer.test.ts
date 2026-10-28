import type * as LaunchModule from "../../packages/chat/src/live/chat-session-launch.js";
import type * as ObserverModule from "../../packages/chat/src/live/chat-attempt-observer.js";
import type { ChatSessionManager as ManagerType } from "../../packages/chat/src/live/chat-session-manager.js";
import type { CliChatUnavailableError as UnavailableError } from "../../packages/chat/src/live/errors.js";
import type { ClassifierShadowRepository } from "../../packages/chat/src/classifier-shadow-repository.js";
import type { DataContextRunner } from "@moss/db";
import { channel } from "node:diagnostics_channel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSessionManagerDeps } from "../../packages/chat/src/live/chat-session-ports.js";
import type { ChatAttemptEvent } from "../../packages/chat/src/live/chat-attempt-observer.js";
import { DEFAULT_CHAT_SURFACE } from "../../packages/chat/src/live/chat-surface.js";
import type { GateRequest } from "../../packages/chat/src/live/classifier-gate.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";

let CliChatUnavailableError: typeof UnavailableError;
const diagnostics = channel("moss.chat.attempt.v1");
let launchChatSession: typeof LaunchModule.launchChatSession;
let ChatSessionManager: typeof ManagerType;
let observer: typeof ObserverModule;
let events: ChatAttemptEvent[];
beforeEach(async () => {
  vi.resetModules();
  events = [];
  const receive = (event: unknown) => {
    events.push(event as ChatAttemptEvent);
  };
  diagnostics.subscribe(receive);
  cleanups.push(() => diagnostics.unsubscribe(receive));
  ({ CliChatUnavailableError } = await import("../../packages/chat/src/live/errors.js"));
  observer = await import("../../packages/chat/src/live/chat-attempt-observer.js");
  ({ launchChatSession } = await import("../../packages/chat/src/live/chat-session-launch.js"));
  ({ ChatSessionManager } = await import("../../packages/chat/src/live/chat-session-manager.js"));
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((clean) => clean());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function harness() {
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
  const deps: { -readonly [Key in keyof ChatSessionManagerDeps]: ChatSessionManagerDeps[Key] } = {
    persistence: {
      resolveActiveProvider: vi.fn(async () => ({ provider: "anthropic" as const, model: "test" })),
      listPriorTurns: vi.fn(async () => ({ recent: [], oldSummary: null })),
      recordTurn: vi.fn(async () => undefined),
      openNewConversation: vi.fn(async () => {}),
      getThreadContext: vi.fn(async () => ({
        threadTitle: null,
        localTimezone: null,
        incognito: false
      })),
      touchExistingThread: vi.fn(async () => true),
      getCurrentThreadState: vi.fn(async () => ({ id: "thread-A", incognito: false }))
    },
    engineFactory: vi.fn(() => engine),
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    persona: "Moss",
    clock: { now: () => 0 },
    idleMs: 60_000,
    neutralBase: "/unused-observer-unit",
    pollMs: 0
  };
  const launch = () =>
    launchChatSession({
      actorUserId: "owner",
      userName: "Owner",
      opts: undefined,
      surface: DEFAULT_CHAT_SURFACE,
      providerIdentity: { provider: "anthropic" as const, model: "test" },
      deps,
      sessions: new Map(),
      sequenceBySession: new Map(),
      serverOwnsDrain: false,
      pollMs: 0
    });
  return { deps, engine, launch };
}

describe("chat attempt observation at real callsites", () => {
  it("records factory entry synchronously before an immediate delegate throw", async () => {
    const h = harness();
    const failure = new Error("synthetic factory failure");
    h.deps.engineFactory = vi.fn(() => {
      expect(events).toContainEqual(expect.objectContaining({ site: "factory", phase: "entry" }));
      throw failure;
    });
    await expect(h.launch()).rejects.toBe(failure);
    expect(events).toContainEqual(
      expect.objectContaining({ site: "factory", phase: "settle", outcome: "error" })
    );
  });
});

const identity = { actorUserId: "owner", surface: DEFAULT_CHAT_SURFACE, turnId: "turn-A" };
function scoped<T>(work: () => T): T {
  return observer.observeChatTurn(identity, () => {
    observer.bindChatAttemptThread("thread-A", identity);
    return work();
  });
}
function entries() {
  return events.filter((event) => event.phase === "entry");
}

it("correlates a real ordinary turn through replay, submit and terminal cleanup", async () => {
  const h = harness();
  vi.mocked(h.deps.persistence.listPriorTurns).mockResolvedValue({
    recent: [{ role: "user", content: "Prior" }],
    oldSummary: null
  });
  h.deps.clearCurrentTurnId = () => {
    expect(events).not.toContainEqual(expect.objectContaining({ site: "turn", phase: "settle" }));
  };
  expect((await new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello")).reply).toBe(
    "Done."
  );
  expect(entries().map((event) => event.site)).toEqual([
    "turn",
    "ensure.initial",
    "factory",
    "launch",
    "replay.submit",
    "submit.initial"
  ]);
  const turn = events.find((event) => event.site === "turn" && event.phase === "settle");
  expect(turn).toMatchObject({
    actorUserId: "owner",
    threadId: "thread-A",
    surface: DEFAULT_CHAT_SURFACE,
    outcome: "ok",
    aborted: false
  });
  expect(turn?.turnId).toBeTruthy();
  expect(entries().every((event) => event.turnId === turn?.turnId)).toBe(true);
  expect(events.every((event) => event.observerError === undefined)).toBe(true);
});

it("observes initial ensure failure and retry without changing the selected factory or receiver", async () => {
  const h = harness();
  let attempts = 0;
  h.deps.engineFactory = function (this: ChatSessionManagerDeps) {
    expect(this).toBe(h.deps);
    if (++attempts === 1) throw new CliChatUnavailableError("synthetic unavailable");
    return h.engine;
  };
  expect((await new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello")).reply).toBe(
    "Done."
  );
  expect(events).toContainEqual(
    expect.objectContaining({ site: "ensure.initial", phase: "settle", outcome: "error" })
  );
  expect(entries().filter((event) => event.site === "ensure.retry")).toHaveLength(1);
  expect(entries().filter((event) => event.site === "factory")).toHaveLength(2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function nextEvent(site: string, phase = "settle") {
  return new Promise<ChatAttemptEvent>((resolve) => {
    const receive = (value: unknown) => {
      const event = value as ChatAttemptEvent;
      if (event.site === site && event.phase === phase) {
        diagnostics.unsubscribe(receive);
        resolve(event);
      }
    };
    diagnostics.subscribe(receive);
    cleanups.push(() => diagnostics.unsubscribe(receive));
  });
}

it("keeps healing and replacement launch open after Stop releases the turn", async () => {
  const h = harness();
  const manager = new ChatSessionManager(h.deps);
  // A cold launch outside an accepted turn is intentionally unknown-context work.
  await manager.ensureSession("owner", "Owner");
  const entered = deferred<void>();
  const released = deferred<void>();
  vi.mocked(h.engine.submit).mockRejectedValueOnce(
    new CliChatUnavailableError("synthetic pre-entry")
  );
  vi.mocked(h.engine.launch).mockImplementation(async function (this: CliChatEngine) {
    expect(this).toBe(h.engine);
    entered.resolve();
    await released.promise;
    return { offset: 0 };
  });
  const turn = manager.submitTurn("owner", "Owner", "Hello");
  await entered.promise;
  await manager.stopTurn("owner");
  expect(await turn).toEqual({ reply: "" });
  expect(events).toContainEqual(expect.objectContaining({ site: "heal", phase: "entry" }));
  expect(events).not.toContainEqual(expect.objectContaining({ site: "heal", phase: "settle" }));
  const settled = nextEvent("heal");
  released.resolve();
  expect(await settled).toMatchObject({ outcome: "aborted", aborted: true, threadId: "thread-A" });
  expect(entries().filter((event) => event.site === "submit.retry")).toHaveLength(0);
});

it("records heal and resubmit exactly once after verified pre-entry failure", async () => {
  const h = harness();
  vi.mocked(h.engine.submit).mockRejectedValueOnce(
    new CliChatUnavailableError("synthetic pre-entry")
  );
  expect((await new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello")).reply).toBe(
    "Done."
  );
  expect(entries().filter((event) => event.site === "heal")).toHaveLength(1);
  expect(entries().filter((event) => event.site === "submit.retry")).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({ site: "submit.initial", phase: "settle", outcome: "error" })
  );
});

it("keeps shadow start distinct from the detached body and its eventual failure", async () => {
  const { createClassifierGateShadowRunner, beginClassifierGateShadowTurn } =
    await import("../../packages/chat/src/live/classifier-gate-shadow.js");
  const pending = deferred<"off">();
  const runner = createClassifierGateShadowRunner({
    readMode: () => pending.promise,
    createPorts: () => {
      throw new Error("not reached in off mode");
    },
    repository: {} as never,
    dataContext: {} as never,
    tokens: { mint: () => "unused", revoke: () => {} },
    listToolNames: async () => [],
    thresholdVersion: "unit",
    now: () => 0
  });
  const controller = new AbortController();
  scoped(() =>
    beginClassifierGateShadowTurn(
      runner,
      "owner",
      DEFAULT_CHAT_SURFACE,
      "PRIVATE MESSAGE MUST NOT ESCAPE",
      false,
      {
        threadId: "thread-A",
        hasAttachment: false,
        signal: controller.signal,
        turnId: "turn-A"
      }
    )
  );
  expect(events).toContainEqual(
    expect.objectContaining({ site: "shadow.start", phase: "settle", outcome: "ok" })
  );
  expect(events).toContainEqual(expect.objectContaining({ site: "shadow.run", phase: "entry" }));
  expect(events).not.toContainEqual(
    expect.objectContaining({ site: "shadow.run", phase: "settle" })
  );
  const settled = nextEvent("shadow.run");
  pending.reject(new Error("PRIVATE ERROR MUST NOT ESCAPE"));
  expect(await settled).toMatchObject({ outcome: "error", threadId: "thread-A" });
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE/);
});

it.each(["throw", "reject", "abort"] as const)(
  "observes actual classifier evaluate %s and preserves fallback/Stop",
  async (mode) => {
    const h = harness();
    const failure = new Error("synthetic evaluate failure");
    h.deps.classifierGate = {
      mode: async () => "on",
      evaluate: function (request: GateRequest) {
        expect(this).toBe(h.deps.classifierGate);
        expect(entries().at(-1)?.site).toBe("classifier.evaluate");
        if (mode === "throw") throw failure;
        if (mode === "abort") {
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
              once: true
            });
            void manager.stopTurn("owner");
          });
        }
        return Promise.reject(failure);
      }
    };
    const manager = new ChatSessionManager(h.deps);
    const result = await manager.submitTurn("owner", "Owner", "Hello");
    expect(result.reply).toBe(mode === "abort" ? "" : "Done.");
    expect(events).toContainEqual(
      expect.objectContaining({
        site: "classifier.evaluate",
        phase: "settle",
        outcome: mode === "abort" ? "aborted" : "error",
        threadId: "thread-A"
      })
    );
    if (mode === "abort")
      expect(entries().map((event) => event.site)).toEqual(["turn", "classifier.evaluate"]);
  }
);

it.each(["launch", "submit"] as const)(
  "observes %s rejection and preserves the exact error",
  async (site) => {
    const h = harness();
    const failure = new Error("synthetic delegate failure");
    vi.mocked(h.engine[site]).mockRejectedValueOnce(failure);
    await expect(new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello")).rejects.toBe(
      failure
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        site: site === "submit" ? "submit.initial" : site,
        phase: "settle",
        outcome: "error",
        aborted: false
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        site: "turn",
        phase: "settle",
        outcome: "error",
        threadId: "thread-A"
      })
    );
  }
);

it("retains promise/result/error identity without replacing delegates", async () => {
  const pending = deferred<object>();
  const result = { safe: true };
  scoped(() => {
    expect(observer.observeChatAttempt("launch", () => pending.promise)).toBe(pending.promise);
    expect(observer.observeChatAttempt("factory", () => result)).toBe(result);
    const error = new Error("synthetic immediate");
    expect(() =>
      observer.observeChatAttempt("submit.initial", () => {
        throw error;
      })
    ).toThrow(error);
  });
  const settled = nextEvent("launch");
  pending.resolve(result);
  expect(await settled).toMatchObject({ outcome: "ok" });
});

it("registers exact version1 coverage and keeps entry/settlement IDs and sequence continuous", async () => {
  const h = harness();
  await new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello");
  const coverage = events.filter((event) => event.phase === "coverage").at(-1)?.sites;
  expect([...(coverage ?? [])].sort()).toEqual(
    [
      "turn",
      "ensure.initial",
      "ensure.retry",
      "heal",
      "factory",
      "launch",
      "replay.submit",
      "submit.initial",
      "submit.retry",
      "classifier.evaluate",
      "shadow.start",
      "shadow.run"
    ].sort()
  );
  for (const entry of entries()) {
    expect(entry.attemptId).toBe(entry.sequence);
    expect(
      events.filter((event) => event.phase === "settle" && event.attemptId === entry.attemptId)
    ).toHaveLength(1);
  }
  expect(
    events.every(
      (event, index) => index === 0 || event.sequence === events[index - 1]!.sequence + 1
    )
  ).toBe(true);
});

it("leaves disabled callsites direct, creates no async context and keeps engine identity", async () => {
  cleanups.splice(0).forEach((clean) => clean());
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const run = vi.spyOn(AsyncLocalStorage.prototype, "run");
  const timers = vi.spyOn(globalThis, "setTimeout");
  expect(observer.chatAttemptObservationEnabled()).toBe(false);
  const h = harness();
  const factory = h.deps.engineFactory;
  const launch = h.engine.launch;
  const submit = h.engine.submit;
  const manager = new ChatSessionManager(h.deps);
  expect((await manager.submitTurn("owner", "Owner", "Hello")).reply).toBe("Done.");
  expect(h.deps.engineFactory).toBe(factory);
  expect((await manager.ensureSession("owner", "Owner")).engine).toBe(h.engine);
  expect(h.engine.launch).toBe(launch);
  expect(h.engine.submit).toBe(submit);
  expect(run).not.toHaveBeenCalled();
  expect(timers).not.toHaveBeenCalled();
  expect(observer.chatAttemptObservationEnabled()).toBe(false);
});

it.each(["missing", "actor", "thread", "turn", "surface", "unbound"] as const)(
  "keeps %s context failure sticky across later valid work",
  async (kind) => {
    const h = harness();
    if (kind === "missing") await h.launch();
    else
      observer.observeChatTurn(identity, () => {
        if (kind === "unbound") return;
        observer.bindChatAttemptThread("thread-A", identity);
        observer.observeChatAttempt("launch", () => undefined, {
          ...identity,
          actorUserId: kind === "actor" ? "other-owner" : "owner",
          surface: kind === "surface" ? "other-surface" : "drawer",
          turnId: kind === "turn" ? "other-turn" : "turn-A",
          threadId: kind === "thread" ? "other-thread" : "thread-A"
        });
      });
    scoped(() => observer.observeChatAttempt("submit.initial", () => undefined));
    expect(events.at(-1)?.observerError).toBe(
      kind === "missing"
        ? "unknown_context"
        : kind === "unbound"
          ? "unknown_thread"
          : "context_mismatch"
    );
  }
);

it.each(["initialization", "validation", "serialization", "socket", "timer", "rejection"] as const)(
  "contains guarded subscriber %s failure without changing product results",
  async (kind) => {
    const failure = new Error("PRIVATE SUBSCRIBER ERROR");
    let failed = false;
    const failureSeen = deferred<void>();
    const protectedCallback = observer.guardChatAttemptObserver(() => {
      failed = true;
      failureSeen.resolve();
      switch (kind) {
        case "rejection":
          return Promise.reject(failure);
        case "validation":
          JSON.parse("invalid-json");
          return;
        case "serialization":
          JSON.stringify({ value: 1n });
          return;
        default:
          throw failure;
      }
    });
    const receive = () => {
      if (!failed && kind !== "initialization" && kind !== "socket" && kind !== "timer")
        protectedCallback();
    };
    if (kind === "initialization") protectedCallback();
    if (kind === "socket") {
      const { EventEmitter } = await import("node:events");
      const socket = new EventEmitter();
      socket.on("error", protectedCallback);
      socket.emit("error", failure);
    }
    if (kind === "timer") {
      vi.useFakeTimers();
      setTimeout(protectedCallback, 1);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
    }
    diagnostics.subscribe(receive);
    cleanups.push(() => diagnostics.unsubscribe(receive));
    const h = harness();
    expect((await new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello")).reply).toBe(
      "Done."
    );
    await failureSeen.promise;
    expect(events.at(-1)?.observerError).toBe("subscriber_error");
    expect(JSON.stringify(events)).not.toContain("PRIVATE SUBSCRIBER ERROR");
  }
);

it("binds a terminal scheduled-read refusal to its captured thread without fallback", async () => {
  const h = harness();
  h.deps.persistence.getMainThreadState = async () => ({ id: "thread-A", incognito: false });
  h.deps.persistence.resolveScheduledReadRequest = async () => ({
    kind: "scheduled_read",
    taskId: null,
    when: null,
    title: "",
    failure: "invalid",
    interpretationStarted: true
  });
  const result = await new ChatSessionManager(h.deps).submitTurn(
    "owner",
    "Owner",
    "Check my Synthetic task in 30 minutes"
  );
  expect(result.reply).toBeTruthy();
  expect(entries().map((event) => event.site)).toEqual(["turn"]);
  expect(events.at(-1)).toMatchObject({
    site: "turn",
    phase: "settle",
    actorUserId: "owner",
    threadId: "thread-A",
    surface: DEFAULT_CHAT_SURFACE,
    outcome: "ok"
  });
  expect(events.at(-1)?.observerError).toBeUndefined();
});

it.each([false, true])(
  "keeps actual shadow work open through storage and token finally (abort=%s)",
  async (abort) => {
    const { createClassifierGateShadowRunner, beginClassifierGateShadowTurn } =
      await import("../../packages/chat/src/live/classifier-gate-shadow.js");
    const reachedComplete = deferred<void>();
    const releaseComplete = deferred<boolean>();
    let revoked = false;
    const runner = createClassifierGateShadowRunner({
      readMode: async () => "shadow",
      createPorts: () => ({
        classifier: { resolve: async () => null, choose: vi.fn(), extract: vi.fn() },
        listTools: async () => [],
        loadCandidates: async () => [],
        isReleased: () => true,
        gateway: { call: async () => ({ kind: "would_run", approvalMode: "auto" }) }
      }),
      repository: {
        open: async () => true,
        complete: async () => {
          reachedComplete.resolve();
          return releaseComplete.promise;
        },
        observeModelTool: async () => true
      } as unknown as ClassifierShadowRepository,
      dataContext: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as unknown as DataContextRunner,
      tokens: {
        mint: () => "synthetic-token",
        revoke: () => {
          revoked = true;
        }
      },
      listToolNames: async () => [],
      thresholdVersion: "unit",
      now: () => 0
    });
    const controller = new AbortController();
    scoped(() =>
      beginClassifierGateShadowTurn(runner, "owner", DEFAULT_CHAT_SURFACE, "Hello", false, {
        threadId: "thread-A",
        turnId: "turn-A",
        hasAttachment: false,
        signal: controller.signal
      })
    );
    await reachedComplete.promise;
    expect(events).toContainEqual(
      expect.objectContaining({ site: "classifier.evaluate", phase: "settle", outcome: "ok" })
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ site: "shadow.run", phase: "settle" })
    );
    expect(revoked).toBe(false);
    if (abort) controller.abort();
    const settled = nextEvent("shadow.run");
    releaseComplete.resolve(true);
    expect(await settled).toMatchObject({
      outcome: abort ? "aborted" : "ok",
      aborted: abort,
      threadId: "thread-A"
    });
    expect(revoked).toBe(true);
  }
);

it("contains direct subscriber failure and retains sticky failure on later events", () => {
  const callback = observer.guardChatAttemptObserver(() => {
    throw new Error("synthetic direct");
  });
  expect(() => callback()).not.toThrow();
  scoped(() => observer.observeChatAttempt("launch", () => undefined));
  expect(events.at(-1)?.observerError).toBe("subscriber_error");
});

it.each(["launch", "submit"] as const)(
  "records immediate %s throws before the delegate while preserving receiver",
  async (site) => {
    const h = harness();
    const failure = new Error("synthetic immediate");
    vi.mocked(h.engine[site]).mockImplementationOnce(function (this: CliChatEngine) {
      expect(this).toBe(h.engine);
      expect(entries().at(-1)?.site).toBe(site === "submit" ? "submit.initial" : site);
      throw failure;
    });
    await expect(new ChatSessionManager(h.deps).submitTurn("owner", "Owner", "Hello")).rejects.toBe(
      failure
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        site: site === "submit" ? "submit.initial" : site,
        phase: "settle",
        outcome: "error"
      })
    );
  }
);

it("records a pending submit's actual rejection after Stop with the original cancellation", async () => {
  const h = harness();
  const entered = deferred<void>();
  const released = deferred<void>();
  vi.mocked(h.engine.submit).mockImplementationOnce(() => {
    entered.resolve();
    return released.promise;
  });
  const manager = new ChatSessionManager(h.deps);
  const turn = manager.submitTurn("owner", "Owner", "Hello");
  await entered.promise;
  await manager.stopTurn("owner");
  expect(events).not.toContainEqual(
    expect.objectContaining({ site: "submit.initial", phase: "settle" })
  );
  released.reject(new Error("synthetic stopped submit"));
  expect(await turn).toEqual({ reply: "" });
  expect(events).toContainEqual(
    expect.objectContaining({
      site: "submit.initial",
      phase: "settle",
      outcome: "aborted",
      aborted: true
    })
  );
});

it("marks an actual launch for a different thread as sticky mismatch without relabeling the turn", async () => {
  const h = harness();
  vi.mocked(h.deps.persistence.getCurrentThreadState!).mockResolvedValue({
    id: "thread-B",
    incognito: false
  });
  const session = await scoped(h.launch);
  expect(session.threadId).toBe("thread-B");
  expect(events).toContainEqual(
    expect.objectContaining({
      site: "factory",
      phase: "entry",
      threadId: "thread-A",
      observerError: "context_mismatch"
    })
  );
  expect(events.at(-1)?.observerError).toBe("context_mismatch");
});
