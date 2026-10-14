import { describe, expect, it } from "vitest";
import type { ProviderKind } from "@moss/ai";

import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "./chat-session-manager.js";
import { ClassifierGate, type GateOutcome, type GateRequest } from "./classifier-gate.js";
import { CliChatUnavailableError } from "./errors.js";
import type { ClassifierGateShadowTurnInput } from "./classifier-gate-shadow.js";
import type { CliChatEngine, TranscriptRecord } from "./types.js";
import type { ChatSurface } from "./chat-surface.js";
import type { ChatTurnOriginV1 } from "@moss/shared";
import type { HandledTurnOptions } from "./chat-session-ports.js";

class FakeClock implements Clock {
  now(): number {
    return 1_725_000_000_000;
  }
}

const noopPersonaFs = {
  async mkdir() {},
  async writeFile() {}
};

/** A thread store where the test flips the current thread like a new chat would. */
class FlipFlopPersistence implements ChatPersistencePort {
  private thread = { id: "thread-private", incognito: true };
  private noThread = false;
  mainStateReads = 0;
  readonly recordedTurns: string[] = [];
  readonly recordedThreadIds: Array<string | null | undefined> = [];
  readonly recordedHandled: string[] = [];

  /** Simulate a purge that deletes the current thread: no current thread after. */
  clearThread(): void {
    this.noThread = true;
  }

  setPrivate(): void {
    this.thread = { id: "thread-private", incognito: true };
  }

  setNormal(): void {
    this.thread = { id: "thread-normal", incognito: false };
  }

  providerCalls = 0;
  private providerHold: { wait: Promise<void>; open: () => void } | null = null;

  /** Park provider resolution from the second call on, until openProvider. */
  holdProviderFromSecondCall(): void {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.providerHold = { wait, open };
  }

  openProvider(): void {
    this.providerHold?.open();
  }

  async resolveActiveProvider(_actorUserId: string) {
    this.providerCalls += 1;
    if (this.providerCalls >= 2 && this.providerHold) await this.providerHold.wait;
    return { provider: "anthropic" as ProviderKind, model: "claude-3-7-sonnet" };
  }

  async openNewConversation(
    _actorUserId: string,
    options?: { incognito?: boolean },
    _surface?: ChatSurface
  ): Promise<void> {
    this.thread = { id: "thread-new", incognito: options?.incognito ?? false };
    this.noThread = false;
  }

  async getCurrentThreadState() {
    if (this.noThread) return undefined;
    return { ...this.thread };
  }

  async getMainThreadState() {
    this.mainStateReads += 1;
    return { id: "thread-main", incognito: false };
  }

  async getThreadContext() {
    return { threadTitle: null, localTimezone: null, incognito: this.thread.incognito };
  }

  async touchExistingThread(_actorUserId: string, threadId: string): Promise<boolean> {
    this.thread = { id: threadId, incognito: false };
    this.noThread = false;
    return true;
  }

  async listPriorTurns() {
    return { recent: [], oldSummary: null };
  }

  async recordTurn(
    _actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string },
    opts?: { readonly threadId?: string | null }
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }> {
    this.recordedTurns.push(userText);
    this.recordedThreadIds.push(opts?.threadId);
    return { userMessageId: "user-msg-1", assistantMessageId: "asst-msg-1" };
  }

  async recordHandledTurn(
    _actorUserId: string,
    userText: string,
    _assistantReply: string,
    _origin: ChatTurnOriginV1,
    _opts?: HandledTurnOptions
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }> {
    this.recordedHandled.push(userText);
    return { userMessageId: "user-msg-1", assistantMessageId: "asst-msg-1" };
  }
}

class DeferredGate {
  readonly evaluateCalls: GateRequest[] = [];
  private resolveMode!: (mode: "off" | "shadow" | "on") => void;
  private resolveEvaluate!: () => void;
  private resolveEvaluateEntered!: () => void;
  readonly modeGate = new Promise<"off" | "shadow" | "on">((resolve) => {
    this.resolveMode = resolve;
  });
  readonly evaluateEntered = new Promise<void>((resolve) => {
    this.resolveEvaluateEntered = resolve;
  });
  readonly evaluateWait = new Promise<void>((resolve) => {
    this.resolveEvaluate = resolve;
  });
  openMode(mode: "off" | "shadow" | "on"): void {
    this.resolveMode(mode);
  }
  openEvaluate(): void {
    this.resolveEvaluate();
  }
  readonly runner = {
    mode: (_actorUserId: string) => this.modeGate,
    evaluate: async (request: GateRequest): Promise<GateOutcome> => {
      this.evaluateCalls.push(request);
      this.resolveEvaluateEntered();
      await this.evaluateWait;
      return { kind: "declined", reason: "gate_off", trace: { latencyMs: 0 } };
    }
  };
}

class RecordingShadow {
  readonly starts: ClassifierGateShadowTurnInput[] = [];
  readonly runner = {
    start: (input: ClassifierGateShadowTurnInput) => {
      this.starts.push(input);
    },
    observeModelTool: () => {},
    noModelTool: () => {},
    cancelTurn: () => {}
  };
}

/** An engine whose first read blocks until the test releases it. */
class BlockingEngine implements CliChatEngine {
  readonly provider = "anthropic" as ProviderKind;
  readonly submits: string[] = [];
  startsToolClientPerTurn = false;

  get readCalls(): number {
    return this.reads;
  }
  interruptCalls = 0;
  // Declared before readEntered: class-field define semantics would otherwise
  // reset these to undefined after the readEntered initializer assigns them.
  private releaseRead!: (value: {
    records: TranscriptRecord[];
    offset: number;
    complete: boolean;
  }) => void;
  private readEnteredResolve!: () => void;
  readonly readEntered = new Promise<void>((resolve) => {
    this.readEnteredResolve = resolve;
  });
  private reads = 0;

  launchCalls = 0;

  async launch(): Promise<{ offset: number }> {
    this.launchCalls += 1;
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.submits.push(text);
  }

  async readNew(): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (++this.reads === 1) this.readEnteredResolve();
    return new Promise((resolve) => {
      this.releaseRead = resolve;
    });
  }

  releaseComplete(reply: string): void {
    this.releaseRead({ records: [{ kind: "reply", text: reply }], offset: 1, complete: true });
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async kill(): Promise<void> {}
}

/**
 * Give the turn time to run past the point under test, then release the read
 * in case the guard under test is missing and the turn kept going. Resolves
 * early when the engine was never reached (the fixed behavior).
 */
async function settleTurn(engine: BlockingEngine, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (engine.readCalls === 0 && Date.now() - start < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (engine.readCalls > 0) engine.releaseComplete("late");
}

function baseDeps(
  persistence: FlipFlopPersistence,
  engine: BlockingEngine,
  extra?: Partial<ChatSessionManagerDeps>
): ChatSessionManagerDeps {
  return {
    engineFactory: () => engine,
    persistence,
    personaFs: noopPersonaFs,
    clock: new FakeClock(),
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "persona",
    pollMs: 0,
    ...extra
  };
}

describe("#2934 new chat must stop a running turn", () => {
  it("uses the durable Main chat for a cold drawer launch", async () => {
    const persistence = new FlipFlopPersistence();
    persistence.setNormal();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(baseDeps(persistence, engine));

    const session = await manager.ensureSession("user-1", "Ben");

    expect(session.threadId).toBe("thread-main");
    expect(persistence.mainStateReads).toBe(2);
  });

  it("binds a cold classifier turn and its stored reply to Main", async () => {
    const persistence = new FlipFlopPersistence();
    persistence.setNormal();
    const gate = new DeferredGate();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, { classifierGate: gate.runner })
    );

    const turn = manager.submitTurn("user-1", "Ben", "normal text");
    gate.openMode("on");
    await gate.evaluateEntered;
    expect(gate.evaluateCalls[0]?.threadId).toBe("thread-main");
    gate.openEvaluate();
    await engine.readEntered;
    engine.releaseComplete("reply");
    await turn;

    expect(persistence.recordedThreadIds).toEqual(["thread-main"]);
  });

  it("keeps an explicit New chat side thread selected for its next classifier turn", async () => {
    const persistence = new FlipFlopPersistence();
    persistence.setNormal();
    const gate = new DeferredGate();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, { classifierGate: gate.runner })
    );

    await manager.clear("user-1");
    const turn = manager.submitTurn("user-1", "Ben", "normal text");
    gate.openMode("on");
    await gate.evaluateEntered;
    expect(gate.evaluateCalls[0]?.threadId).toBe("thread-new");
    gate.openEvaluate();
    await engine.readEntered;
    engine.releaseComplete("reply");
    await turn;

    expect(persistence.recordedThreadIds).toEqual(["thread-new"]);
  });

  it("T1: a thread flip inside the gate-mode wait is refused, never classified, submitted, or saved", async () => {
    const persistence = new FlipFlopPersistence();
    const gate = new DeferredGate();
    const shadow = new RecordingShadow();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, {
        classifierGate: gate.runner,
        classifierGateShadow: shadow.runner
      })
    );

    await manager.clear("user-1", { incognito: true });

    const turn = manager.submitTurn("user-1", "Ben", "private text");
    await Promise.resolve();
    // The new chat finishes inside the gate-mode wait. This flips the thread
    // with no stop signal, so the test isolates the privacy layers from the
    // stop layer (covered by T2).
    await persistence.openNewConversation("user-1", undefined, undefined);
    gate.openMode("on");
    gate.openEvaluate();
    await settleTurn(engine);

    const result = await turn;
    expect(result.reply).toBe("");
    expect(gate.evaluateCalls).toEqual([]);
    expect(persistence.recordedHandled).toEqual([]);
    expect(persistence.recordedTurns).toEqual([]);
    expect(shadow.starts).toEqual([]);
    expect(engine.submits).toEqual([]);
  });

  it("T2: a real new chat stops the default-path turn before it is saved", async () => {
    const persistence = new FlipFlopPersistence();
    persistence.setNormal();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(baseDeps(persistence, engine));
    const seen: TranscriptRecord[] = [];
    manager.subscribe("user-1", (record) => seen.push(record));

    const turn = manager.submitTurn("user-1", "Ben", "normal text");
    await engine.readEntered;
    await manager.clear("user-1");
    engine.releaseComplete("too late");

    const result = await turn;
    expect(result.reply).toBe("");
    expect(persistence.recordedTurns).toEqual([]);
    expect(engine.interruptCalls).toBe(1);
    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "status", text: "Stopped by user." })
    );
  });

  it("T4 (finding 1): a real new chat inside the evaluate wait never reaches the new model", async () => {
    // Normal thread so the gate evaluates instead of bypassing: this isolates
    // the stop-between-gate-and-submit mechanism. The private-text property is
    // covered by T1 (refusal on privacy mismatch) and T5 (end-private route).
    const persistence = new FlipFlopPersistence();
    persistence.setNormal();
    const gate = new DeferredGate();
    const shadow = new RecordingShadow();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, {
        classifierGate: gate.runner,
        classifierGateShadow: shadow.runner
      })
    );
    const seen: TranscriptRecord[] = [];
    manager.subscribe("user-1", (record) => seen.push(record));

    persistence.holdProviderFromSecondCall();
    const turn = manager.submitTurn("user-1", "Ben", "normal text");
    await Promise.resolve();
    gate.openMode("on");
    await gate.evaluateEntered;
    gate.openEvaluate();
    // The turn parks at the second provider read (past the gate, before the
    // submit), so the real new chat lands exactly in that window.
    const parkedAt = Date.now();
    while (persistence.providerCalls < 2 && Date.now() - parkedAt < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(persistence.providerCalls).toBeGreaterThanOrEqual(2);
    await manager.clear("user-1");
    persistence.openProvider();
    await settleTurn(engine);

    const result = await turn;
    expect(result.reply).toBe("");
    expect(engine.submits).toEqual([]);
    expect(persistence.recordedTurns).toEqual([]);
    expect(persistence.recordedHandled).toEqual([]);
    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "status", text: "Stopped by user." })
    );
  });

  it("T5 (finding 2): ending the private chat stops the running turn before it launches post-purge work", async () => {
    const persistence = new FlipFlopPersistence();
    const gate = new DeferredGate();
    const shadow = new RecordingShadow();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, {
        classifierGate: gate.runner,
        classifierGateShadow: shadow.runner
      })
    );

    await manager.clear("user-1", { incognito: true });

    const turn = manager.submitTurn("user-1", "Ben", "private text");
    await Promise.resolve();
    await manager.endPrivateSession("user-1");
    // The purge deleted the private thread; the next launch auto-opens normal.
    persistence.clearThread();
    gate.openMode("on");
    gate.openEvaluate();
    await settleTurn(engine);

    const result = await turn;
    expect(result.reply).toBe("");
    expect(engine.launchCalls).toBe(0);
    expect(engine.submits).toEqual([]);
    expect(persistence.recordedTurns).toEqual([]);
    expect(persistence.recordedHandled).toEqual([]);
    expect(gate.evaluateCalls).toEqual([]);
  });

  it("T6: a stop inside the tools-readiness wait still stops the save", async () => {
    const persistence = new FlipFlopPersistence();
    persistence.setNormal();
    const engine = new BlockingEngine();
    engine.startsToolClientPerTurn = true;
    let observedCount = 5;
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, {
        mintMcpToken: async () => ({ token: "tok", mcpServerUrl: "http://x" }),
        getToolsListObservationCount: () => observedCount
      })
    );

    const turn = manager.submitTurn("user-1", "Ben", "normal text");
    await engine.readEntered;
    engine.releaseComplete("hi");
    // The turn now waits on the tools-list observation; stop inside that wait.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await manager.clear("user-1");
    observedCount = 6;

    await turn;
    expect(persistence.recordedTurns).toEqual([]);
    expect(engine.interruptCalls).toBe(1);
  });

  it("T7 (round 2): a new chat during the reconnect heal never re-sends private text", async () => {
    // Adapted from QA's round-2 probe: a private turn whose first send fails as
    // unavailable heals ("reconnecting") and would resubmit once. A real new
    // chat lands inside the heal, so the healed session belongs to the new
    // normal thread. The retry must refuse instead of re-sending private text.
    const persistence = new FlipFlopPersistence();

    class FailingPrivateEngine extends BlockingEngine {
      submitCalls = 0;
      async purgeTranscripts(): Promise<void> {}
      override async submit(_text: string): Promise<void> {
        this.submitCalls += 1;
        throw new CliChatUnavailableError("daemon gone");
      }
    }
    class HealedEngine extends BlockingEngine {
      async purgeTranscripts(): Promise<void> {}
    }
    const dead = new FailingPrivateEngine();
    const healed = new HealedEngine();

    let factoryCalls = 0;
    let releaseHeal!: () => void;
    const healGate = new Promise<void>((resolve) => {
      releaseHeal = resolve;
    });
    const manager = new ChatSessionManager(
      baseDeps(persistence, dead, {
        engineFactory: (async () => {
          factoryCalls += 1;
          if (factoryCalls === 1) return dead;
          await healGate;
          return healed;
        }) as unknown as ChatSessionManagerDeps["engineFactory"]
      })
    );
    const seen: TranscriptRecord[] = [];
    manager.subscribe("user-1", (record) => seen.push(record));

    await manager.clear("user-1", { incognito: true });

    const turn = manager.submitTurn("user-1", "Ben", "private text");
    // Wait until the turn is inside the heal (second launch parked).
    const parkedAt = Date.now();
    while (factoryCalls < 2 && Date.now() - parkedAt < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
    // The user presses New chat while "reconnecting" shows.
    await manager.clear("user-1");
    releaseHeal();
    // Give the retry time to (incorrectly) resubmit, then drain the read loop
    // in case the guard is missing and the turn kept going.
    const submitAt = Date.now();
    while (healed.submits.length === 0 && Date.now() - submitAt < 500) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await settleTurn(healed);

    const result = await turn;
    expect(result.reply).toBe("");
    expect(healed.submits).toEqual([]);
    expect(persistence.recordedTurns).toEqual([]);
    expect(persistence.recordedHandled).toEqual([]);
    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "status", text: "Stopped by user." })
    );
  });

  it("T3: the real gate declines a private request before any classifier call", async () => {
    let classifierCalls = 0;
    const gate = new ClassifierGate({
      classifier: {
        resolve: async () => {
          classifierCalls += 1;
          return null;
        },
        choose: async () => {
          throw new Error("classifier must not be reached");
        },
        extract: async () => {
          throw new Error("classifier must not be reached");
        }
      },
      listTools: async () => [],
      loadCandidates: async () => undefined,
      gateway: {
        call: async () => {
          throw new Error("gateway must not be reached");
        }
      },
      isReleased: () => true,
      now: () => 0
    });

    const outcome = await gate.evaluate({
      actorUserId: "user-1",
      threadId: "private-thread",
      message: "private text",
      hasAttachment: false,
      incognito: true,
      mode: "on"
    });

    expect(outcome).toMatchObject({ kind: "declined", reason: "private_chat" });
    expect(classifierCalls).toBe(0);
  });
});
