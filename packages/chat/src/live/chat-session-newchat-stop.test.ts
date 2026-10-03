import { describe, expect, it } from "vitest";
import type { ProviderKind } from "@moss/ai";

import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "./chat-session-manager.js";
import { ClassifierGate, type GateOutcome, type GateRequest } from "./classifier-gate.js";
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
  readonly recordedTurns: string[] = [];
  readonly recordedHandled: string[] = [];

  setPrivate(): void {
    this.thread = { id: "thread-private", incognito: true };
  }

  setNormal(): void {
    this.thread = { id: "thread-normal", incognito: false };
  }

  async resolveActiveProvider(_actorUserId: string) {
    return { provider: "anthropic" as ProviderKind, model: "claude-3-7-sonnet" };
  }

  async openNewConversation(
    _actorUserId: string,
    _options?: { incognito?: boolean },
    _surface?: ChatSurface
  ): Promise<void> {
    this.thread = { id: "thread-new", incognito: false };
  }

  async getCurrentThreadState() {
    return { ...this.thread };
  }

  async getThreadContext() {
    return { threadTitle: null, localTimezone: null, incognito: this.thread.incognito };
  }

  async touchExistingThread(): Promise<boolean> {
    return true;
  }

  async listPriorTurns() {
    return { recent: [], oldSummary: null };
  }

  async recordTurn(
    _actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string }
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }> {
    this.recordedTurns.push(userText);
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
  readonly modeGate = new Promise<"off" | "shadow" | "on">((resolve) => {
    this.resolveMode = resolve;
  });
  openMode(mode: "off" | "shadow" | "on"): void {
    this.resolveMode(mode);
  }
  readonly runner = {
    mode: (_actorUserId: string) => this.modeGate,
    evaluate: async (request: GateRequest): Promise<GateOutcome> => {
      this.evaluateCalls.push(request);
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

  async launch(): Promise<{ offset: number }> {
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
  it("T1: a thread flip inside the gate-mode wait never reaches the classifier or shadow log", async () => {
    const persistence = new FlipFlopPersistence();
    persistence.setPrivate();
    const gate = new DeferredGate();
    const shadow = new RecordingShadow();
    const engine = new BlockingEngine();
    const manager = new ChatSessionManager(
      baseDeps(persistence, engine, {
        classifierGate: gate.runner,
        classifierGateShadow: shadow.runner
      })
    );

    const turn = manager.submitTurn("user-1", "Ben", "private text");
    await Promise.resolve();
    // The new chat finishes inside the gate-mode wait. This flips the thread
    // with no stop signal, so the test isolates the privacy-capture layer (D1-D3)
    // from the stop layer (D4, covered by T2).
    await persistence.openNewConversation("user-1", undefined, undefined);
    gate.openMode("on");
    await engine.readEntered;
    engine.releaseComplete("hello");

    const result = await turn;
    expect(result.reply).toBe("hello");
    expect(gate.evaluateCalls).toEqual([]);
    expect(persistence.recordedHandled).toEqual([]);
    expect(shadow.starts).toEqual([expect.objectContaining({ incognito: true })]);
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
      message: "private text",
      hasAttachment: false,
      incognito: true,
      mode: "on"
    });

    expect(outcome).toMatchObject({ kind: "declined", reason: "private_chat" });
    expect(classifierCalls).toBe(0);
  });
});
