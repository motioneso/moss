/**
 * Task 4.1 (#2901) — handled-turn lifecycle at the shared turn boundary.
 *
 * No real tmux/DB/fs: the engine, persistence, clock, and gate runner are in-memory fakes. The
 * tests assert the behaviour the lane plan names: a handled turn launches no engine, a decline
 * submits the original text exactly once, a terminal failure never replays, a read storage failure
 * falls back while a mutating one never does, Stop stops, warm sessions see the handled turn in
 * normal history, and HTTP/SSE/history agree.
 */
import { describe, expect, it } from "vitest";

import type { ProviderKind } from "../../packages/ai/src/index.js";
import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { ClassifierGateRunner } from "../../packages/chat/src/live/classifier-gate-runner.js";
import type {
  GateMode,
  GateOutcome,
  GateRequest
} from "../../packages/chat/src/live/classifier-gate.js";
import type { PersonaFs } from "../../packages/chat/src/live/persona.js";
import { createClassifierGateRunner } from "../../packages/chat/src/live/classifier-gate-runner.js";
import { serializeMessage, readOrigin } from "../../packages/chat/src/route-serializers.js";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";
import type { ChatClassifierGateOriginV1 } from "@moss/shared";

const NOW = new Date("2026-10-02T12:00:00.000Z");

// ─── fakes ───────────────────────────────────────────────────────────────────

class FakeEngine implements CliChatEngine {
  launchCount = 0;
  killed = false;
  readonly launchOpts: EngineLaunchOpts[] = [];
  readonly submitted: string[] = [];
  private pending: TranscriptRecord[] = [];

  constructor(
    public readonly provider: ProviderKind,
    public readonly sessionKey: string
  ) {}

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchCount += 1;
    this.launchOpts.push(opts);
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.submitted.push(text);
    this.pending = [{ kind: "reply", text: `reply to: ${text}` }];
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.pending.length === 0) {
      return { records: [], offset: afterOffset, complete: false };
    }
    const records = this.pending;
    this.pending = [];
    return { records, offset: afterOffset + 1, complete: true };
  }

  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {}
  async purgeTranscripts(): Promise<void> {}
}

interface HandledRecord {
  readonly userText: string;
  readonly assistantReply: string;
  readonly origin: ChatClassifierGateOriginV1;
}

class FakePersistence implements ChatPersistencePort {
  readonly active = { provider: "anthropic" as ProviderKind, model: "claude-x" };
  readonly turns: { role: "user" | "assistant"; content: string }[] = [];
  readonly handled: HandledRecord[] = [];
  /** When set, recordHandledTurn throws instead of storing. */
  failHandledWrite = false;
  incognito = false;

  async resolveActiveProvider(): Promise<{ provider: ProviderKind; model: string }> {
    return this.active;
  }

  async listPriorTurns(): Promise<{
    recent: readonly { role: "user" | "assistant"; content: string }[];
    oldSummary: string | null;
  }> {
    return { recent: [...this.turns], oldSummary: null };
  }

  async recordTurn(
    _actorUserId: string,
    userText: string,
    assistantReply: string
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }> {
    this.turns.push({ role: "user", content: userText });
    this.turns.push({ role: "assistant", content: assistantReply });
    return { userMessageId: "user-message-id", assistantMessageId: "assistant-message-id" };
  }

  async recordHandledTurn(
    _actorUserId: string,
    userText: string,
    assistantReply: string,
    origin: ChatClassifierGateOriginV1
  ): Promise<{
    readonly userMessageId: string;
    readonly assistantMessageId: string;
  }> {
    if (this.failHandledWrite) throw new Error("storage down");
    this.handled.push({ userText, assistantReply, origin });
    this.turns.push({ role: "user", content: userText });
    this.turns.push({ role: "assistant", content: assistantReply });
    return { userMessageId: "handled-user", assistantMessageId: "handled-assistant" };
  }

  async openNewConversation(): Promise<void> {
    this.turns.length = 0;
  }

  async getThreadContext(): Promise<{
    threadTitle: string | null;
    localTimezone: string | null;
    incognito: boolean;
  }> {
    return { threadTitle: null, localTimezone: null, incognito: this.incognito };
  }

  async getCurrentThreadState(): Promise<{ readonly id: string; readonly incognito: boolean }> {
    return { id: "thread-1", incognito: this.incognito };
  }

  async touchExistingThread(): Promise<boolean> {
    return true;
  }
}

class FakeClock implements Clock {
  now(): number {
    return 0;
  }
}

class FakeGateRunner implements ClassifierGateRunner {
  modeValue: GateMode = "off";
  evaluateCalls = 0;
  readonly requests: GateRequest[] = [];
  outcome: GateOutcome = { kind: "declined", reason: "none", trace: { latencyMs: 1 } };
  failEvaluate = false;
  /**
   * When set, evaluate calls this (e.g. `manager.stopTurn`) to abort the turn and then returns a
   * decline — modelling Stop landing while the gate was deciding, for example a dispatched read
   * that failed after the abort.
   */
  onEvaluate?: () => Promise<void>;

  async mode(): Promise<GateMode> {
    return this.modeValue;
  }

  async evaluate(request: GateRequest): Promise<GateOutcome> {
    this.evaluateCalls += 1;
    this.requests.push(request);
    if (this.onEvaluate) await this.onEvaluate();
    if (this.failEvaluate) throw new Error("gate down");
    return this.outcome;
  }
}

const noopPersonaFs: PersonaFs = {
  async mkdir() {},
  async writeFile() {}
};

interface Harness {
  manager: ChatSessionManager;
  persistence: FakePersistence;
  gate: FakeGateRunner;
  engines: FakeEngine[];
  revoked: string[];
}

function makeManager(over: Partial<ChatSessionManagerDeps> = {}): Harness {
  const persistence = new FakePersistence();
  const gate = new FakeGateRunner();
  const engines: FakeEngine[] = [];
  const revoked: string[] = [];

  const deps: ChatSessionManagerDeps = {
    engineFactory: (provider, sessionKey) => {
      const engine = new FakeEngine(provider, sessionKey);
      engines.push(engine);
      return engine;
    },
    persistence,
    personaFs: noopPersonaFs,
    clock: new FakeClock(),
    idleMs: 1_000,
    neutralBase: "/tmp/jarvis-test",
    persona: "I am Jarvis, {{userName}}.",
    pollMs: 0,
    now: () => NOW,
    revokeMcpToken: (sessionKey) => revoked.push(sessionKey),
    classifierGate: gate,
    ...over
  };

  return { manager: new ChatSessionManager(deps), persistence, gate, engines, revoked };
}

const READ_HANDLED: GateOutcome = {
  kind: "handled",
  reply: "You have 2 events today.",
  trace: {
    moduleId: "calendar",
    toolName: "calendar.listVisibleEvents",
    risk: "read",
    latencyMs: 4
  }
};

const WRITE_HANDLED: GateOutcome = {
  kind: "handled",
  reply: "Added the event.",
  trace: { moduleId: "calendar", toolName: "calendar.createEvent", risk: "write", latencyMs: 7 }
};

const TERMINAL_WRITE: GateOutcome = {
  kind: "terminal_failure",
  message: "That action did not complete, and it was not retried. Check before trying again.",
  trace: { moduleId: "calendar", toolName: "calendar.createEvent", risk: "write", latencyMs: 9 }
};

// ─── tests ───────────────────────────────────────────────────────────────────

describe("classifier gate — handled-turn lifecycle", () => {
  it("off and shadow never call the gate; the default model answers once", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const { manager, gate, engines } = makeManager();
      gate.modeValue = mode;

      const result = await manager.submitTurn("user-1", "Ben", "hello");

      expect(gate.evaluateCalls).toBe(0);
      expect(engines).toHaveLength(1);
      expect(engines[0]?.submitted).toHaveLength(1);
      expect(result.reply).toContain("reply to:");
    }
  });

  it("a handled turn launches no engine and submits nothing", async () => {
    const { manager, gate, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = READ_HANDLED;

    const result = await manager.submitTurn("user-1", "Ben", "what's on today?");

    expect(gate.evaluateCalls).toBe(1);
    expect(engines).toHaveLength(0);
    expect(result.reply).toBe("You have 2 events today.");
    expect(result.reply).not.toContain("reply to:");
  });

  it("a handled turn records the gate origin and no executed provider/model", async () => {
    const { manager, gate, persistence } = makeManager();
    gate.modeValue = "on";
    gate.outcome = READ_HANDLED;

    const result = await manager.submitTurn("user-2", "Ben", "what's on today?");

    expect(persistence.handled).toHaveLength(1);
    const { origin, assistantReply } = persistence.handled[0]!;
    expect(origin.kind).toBe("classifier_gate");
    expect(origin.outcome).toBe("executed-success");
    expect(origin.moduleId).toBe("calendar");
    expect(origin.toolName).toBe("calendar.listVisibleEvents");
    expect(origin.decisionId.length).toBeGreaterThan(0);
    expect(assistantReply).toBe("You have 2 events today.");
    expect(result.assistantMessageId).toBe("handled-assistant");
  });

  it("a declined turn falls through and submits the original text exactly once", async () => {
    const { manager, gate, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = { kind: "declined", reason: "low_confidence", trace: { latencyMs: 2 } };

    await manager.submitTurn("user-3", "Ben", "do the thing");

    expect(gate.evaluateCalls).toBe(1);
    expect(engines).toHaveLength(1);
    expect(engines[0]?.submitted).toHaveLength(1);
    expect(engines[0]?.submitted[0]).toContain("do the thing");
  });

  it("a terminal failure persists the failure and never replays it", async () => {
    const { manager, gate, persistence, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = TERMINAL_WRITE;

    const result = await manager.submitTurn("user-4", "Ben", "add an event");

    expect(engines).toHaveLength(0);
    expect(persistence.handled).toHaveLength(1);
    expect(persistence.handled[0]!.origin.outcome).toBe("executed-failure-or-unknown");
    expect(result.reply).toBe(TERMINAL_WRITE.message);
  });

  it("stopping a gate attempt emits Stopped by user and persists nothing", async () => {
    const { manager, gate, persistence, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = { kind: "cancelled", trace: { latencyMs: 3 } };
    const records: TranscriptRecord[] = [];
    manager.subscribe("user-5", (record) => records.push(record));

    const result = await manager.submitTurn("user-5", "Ben", "stop this");

    expect(result.reply).toBe("");
    expect(engines).toHaveLength(0);
    expect(persistence.handled).toHaveLength(0);
    expect(records).toContainEqual({ kind: "status", text: "Stopped by user." });
  });

  it("Stop during a gate decision never falls through to the default model", async () => {
    // Stop lands while the gate is deciding; the gate then reports a decline (e.g. the read it
    // dispatched failed after the abort). The signal must win: no engine submit, nothing persisted.
    const { manager, gate, persistence, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = { kind: "declined", reason: "read_failed", trace: { latencyMs: 3 } };
    // Stop lands mid-evaluate: stopTurn aborts the turn controller before the decline returns.
    gate.onEvaluate = () => manager.stopTurn("user-12");
    const records: TranscriptRecord[] = [];
    manager.subscribe("user-12", (record) => records.push(record));

    const result = await manager.submitTurn("user-12", "Ben", "stop this");

    expect(gate.evaluateCalls).toBe(1);
    expect(engines).toHaveLength(0);
    expect(persistence.handled).toHaveLength(0);
    expect(result.reply).toBe("");
    expect(records).toContainEqual({ kind: "status", text: "Stopped by user." });
    // The user's message must not be echoed as a submitted model turn.
    expect(records.some((record) => record.kind === "reply")).toBe(false);
  });

  it("a read storage failure falls back, but a mutating storage failure never does", async () => {
    // Read: safe to repeat, so the default model answers once.
    const readHarness = makeManager();
    readHarness.gate.modeValue = "on";
    readHarness.gate.outcome = READ_HANDLED;
    readHarness.persistence.failHandledWrite = true;
    await readHarness.manager.submitTurn("user-6", "Ben", "what's on today?");
    expect(readHarness.engines).toHaveLength(1);
    expect(readHarness.engines[0]?.submitted).toHaveLength(1);

    // Write: already ran, so no default-model replay.
    const writeHarness = makeManager();
    writeHarness.gate.modeValue = "on";
    writeHarness.gate.outcome = WRITE_HANDLED;
    writeHarness.persistence.failHandledWrite = true;
    const writeResult = await writeHarness.manager.submitTurn("user-6", "Ben", "add an event");
    expect(writeHarness.engines).toHaveLength(0);
    expect(writeResult.reply).toContain("could not be saved");
  });

  it("a read storage-failure fallback emits the user message exactly once", async () => {
    // The gate must not echo the user's message before it knows the turn falls back; otherwise the
    // default path emits it again and the live stream shows it twice.
    const harness = makeManager();
    harness.gate.modeValue = "on";
    harness.gate.outcome = READ_HANDLED;
    harness.persistence.failHandledWrite = true;
    const records: TranscriptRecord[] = [];
    harness.manager.subscribe("user-14", (record) => records.push(record));

    await harness.manager.submitTurn("user-14", "Ben", "what's on today?");

    const userRecords = records.filter((record) => record.kind === "user");
    expect(userRecords).toHaveLength(1);
    expect(harness.engines).toHaveLength(1);
  });

  it("treats a handled turn with unknown risk on the trace as mutating (no fallback)", async () => {
    // Fail safe: an unrecognized trace must never be repeated by the default model, because it may
    // have run a mutating tool.
    const { manager, gate, persistence, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = {
      kind: "handled",
      reply: "Done.",
      trace: { moduleId: "mystery", toolName: "mystery.do", latencyMs: 5 }
    };
    persistence.failHandledWrite = true;

    const result = await manager.submitTurn("user-13", "Ben", "do the mystery thing");

    expect(engines).toHaveLength(0);
    expect(result.reply).toContain("could not be saved");
  });

  it("a terminal failure whose storage write fails still returns the failure text", async () => {
    const { manager, gate, persistence, engines } = makeManager();
    gate.modeValue = "on";
    gate.outcome = TERMINAL_WRITE;
    persistence.failHandledWrite = true;

    const result = await manager.submitTurn("user-7", "Ben", "add an event");

    expect(engines).toHaveLength(0);
    expect(result.reply).toBe(TERMINAL_WRITE.message);
  });

  it("a warm session is dropped after a handled turn so the next turn sees normal history", async () => {
    const { manager, gate, persistence, engines, revoked } = makeManager();

    // A normal default turn first, so a warm engine exists.
    await manager.submitTurn("user-8", "Ben", "hello");
    expect(engines).toHaveLength(1);

    // A handled turn must drop that warm session without submitting anything to it.
    gate.modeValue = "on";
    gate.outcome = READ_HANDLED;
    await manager.submitTurn("user-8", "Ben", "what's on today?");
    expect(engines[0]?.killed).toBe(true);
    expect(engines[0]?.submitted).toHaveLength(1); // only the first turn
    expect(revoked).toContain("user-8:drawer");
    expect(persistence.turns.at(-2)).toEqual({ role: "user", content: "what's on today?" });
    expect(persistence.turns.at(-1)).toEqual({
      role: "assistant",
      content: "You have 2 events today."
    });

    // The next default turn relaunches a fresh engine with the handled turn in replay history.
    gate.modeValue = "off";
    await manager.submitTurn("user-8", "Ben", "and tomorrow?");
    expect(engines).toHaveLength(2);
    const replay = engines[1]?.launchOpts[0]?.replayBatch ?? "";
    expect(replay).toContain("You have 2 events today.");
  });

  it("private chats skip the gate entirely", async () => {
    const { manager, gate, persistence } = makeManager();
    gate.modeValue = "on";
    gate.outcome = READ_HANDLED;
    persistence.incognito = true;

    await manager.submitTurn("user-9", "Ben", "private question");

    expect(gate.evaluateCalls).toBe(0);
  });

  it("HTTP, SSE and history agree on the handled reply", async () => {
    const { manager, gate, persistence } = makeManager();
    gate.modeValue = "on";
    gate.outcome = READ_HANDLED;
    const records: TranscriptRecord[] = [];
    manager.subscribe("user-10", (record) => records.push(record));

    const result = await manager.submitTurn("user-10", "Ben", "what's on today?");

    const sseReply = records.find((record) => record.kind === "reply");
    expect(sseReply?.text).toBe("You have 2 events today.");
    expect(sseReply?.messageId).toBe("handled-assistant");
    expect(sseReply?.origin?.kind).toBe("classifier_gate");
    expect(result.reply).toBe(sseReply?.text);
    expect(persistence.handled[0]!.assistantReply).toBe(sseReply?.text);
    expect(persistence.turns.at(-1)).toEqual({
      role: "assistant",
      content: "You have 2 events today."
    });
  });

  it("a gate infrastructure failure declines to the default model", async () => {
    const { manager, gate, engines } = makeManager();
    gate.modeValue = "on";
    gate.failEvaluate = true;

    await manager.submitTurn("user-11", "Ben", "hello");

    expect(engines).toHaveLength(1);
    expect(engines[0]?.submitted).toHaveLength(1);
  });
});

describe("classifier gate runner — token lifecycle", () => {
  it("mints one token per attempt and revokes it even when the attempt throws", async () => {
    const minted: string[] = [];
    const revoked: string[] = [];
    const runner = createClassifierGateRunner({
      readMode: async () => "on",
      createPorts: () => {
        throw new Error("ports unavailable");
      },
      tokens: {
        mint: (_actorUserId, correlationId) => {
          minted.push(correlationId);
          return `tok:${correlationId}`;
        },
        revoke: (correlationId) => revoked.push(correlationId)
      },
      now: () => 0,
      newCorrelationId: () => "corr-1"
    });

    await expect(
      runner.evaluate({
        actorUserId: "user-1",
        threadId: "thread-1",
        message: "hi",
        hasAttachment: false,
        incognito: false,
        mode: "on"
      })
    ).rejects.toThrow("ports unavailable");

    expect(minted).toEqual(["corr-1"]);
    expect(revoked).toEqual(["corr-1"]);
  });

  it("declines after minting and revoking when no ports factory is wired yet", async () => {
    const minted: string[] = [];
    const revoked: string[] = [];
    const runner = createClassifierGateRunner({
      readMode: async () => "on",
      // No createPorts: the live-wiring step has not assembled the tool list/classifier yet.
      tokens: {
        mint: (_actorUserId, correlationId) => {
          minted.push(correlationId);
          return `tok:${correlationId}`;
        },
        revoke: (correlationId) => revoked.push(correlationId)
      },
      now: () => 0,
      newCorrelationId: () => "corr-2"
    });

    const outcome = await runner.evaluate({
      actorUserId: "user-1",
      threadId: "thread-1",
      message: "hi",
      hasAttachment: false,
      incognito: false,
      mode: "on"
    });

    expect(outcome).toEqual({
      kind: "declined",
      reason: "no_eligible_tools",
      trace: { latencyMs: 0 }
    });
    expect(minted).toEqual(["corr-2"]);
    expect(revoked).toEqual(["corr-2"]);
  });
});

describe("classifier gate origin — serialization", () => {
  const validOrigin = {
    version: 1,
    kind: "classifier_gate",
    decisionId: "decision-1",
    moduleId: "calendar",
    toolName: "calendar.listVisibleEvents",
    outcome: "executed-success"
  } as const;

  function message(modelMetadata: Record<string, unknown>): Parameters<typeof serializeMessage>[0] {
    return {
      id: "msg-1",
      thread_id: "thread-1",
      owner_user_id: "user-1",
      role: "assistant",
      status: "stored",
      body: "You have 2 events today.",
      tool_metadata: {},
      model_metadata: modelMetadata,
      created_at: new Date("2026-10-02T12:00:00.000Z"),
      updated_at: new Date("2026-10-02T12:00:00.000Z")
    } as unknown as Parameters<typeof serializeMessage>[0];
  }

  it("reads a valid gate origin and ignores model metadata", () => {
    expect(readOrigin(validOrigin)).toEqual(validOrigin);
    expect(readOrigin({ executed: { provider: "anthropic", model: "claude-x" } })).toBeUndefined();
  });

  it("rejects malformed origins so old history stays readable", () => {
    expect(readOrigin(undefined)).toBeUndefined();
    expect(readOrigin({ ...validOrigin, version: 2 })).toBeUndefined();
    expect(readOrigin({ ...validOrigin, decisionId: "" })).toBeUndefined();
    expect(readOrigin({ ...validOrigin, outcome: "something_else" })).toBeUndefined();
  });

  it("serializes a gate turn with an origin and no usage", () => {
    const dto = serializeMessage(message({ origin: validOrigin }));
    expect(dto.origin).toEqual(validOrigin);
    expect(dto.usage).toBeUndefined();
    expect(dto.elapsedMs).toBeUndefined();
  });

  it("serializes a model turn with usage and no origin", () => {
    const dto = serializeMessage(
      message({
        executed: { provider: "anthropic", model: "claude-x" },
        usage: { inputTokens: 1, outputTokens: 2 }
      })
    );
    expect(dto.origin).toBeUndefined();
    expect(dto.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
