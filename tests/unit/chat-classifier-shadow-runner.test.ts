import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClassifierChoiceResult, ClassifierHandle, GatewayGateOutcome } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";

import type { ClassifierShadowRepository } from "../../packages/chat/src/classifier-shadow-repository.js";
import { GATE_LIMITS, type GateSpeed } from "../../packages/chat/src/live/classifier-gate.js";
import { GateSpeedRecord } from "../../packages/chat/src/live/classifier-gate-speed.js";
import {
  createClassifierGateShadowRunner,
  type ClassifierGateShadowRunnerDeps
} from "../../packages/chat/src/live/classifier-gate-shadow.js";
import type {
  ClassifierGateAttemptPorts,
  ClassifierGatePortsFactory
} from "../../packages/chat/src/live/classifier-gate-wiring.js";
import type { GateTool } from "../../packages/chat/src/live/classifier-gate.js";
import { normalizeChatSurface } from "../../packages/chat/src/live/chat-surface.js";

/**
 * #2907 (plan 3.5) — the shadow runner. The classifier, gateway, repository and data context are
 * all fakes. These prove: off/on/private make no classifier request; a would-handle decision is
 * recorded; observations buffer until the record exists; timeout maps to failed and starts a
 * cross-turn cooldown; and nothing thrown here reaches the caller.
 */

const fakeDb = {} as DataContextDb;
const dataContext = {
  withDataContext: (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) => work(fakeDb)
} as unknown as DataContextRunner;

const usage = { inputTokens: 1, outputTokens: 1 };

function pick(choice: string, confidence = 0.99, lead = 0.8): ClassifierChoiceResult {
  return {
    ok: true,
    choice,
    confidence,
    probabilities: { [choice]: 0.9, other: 0.1 },
    runnerUp: { choice: "other", probability: 0.9 - lead },
    lead,
    usage
  };
}

function handle(): ClassifierHandle {
  return {
    model: {
      id: "m1",
      provider_config_id: "p1",
      provider_kind: "openai-compatible",
      provider_model_id: "classifier-x"
    } as never,
    capability: "typed_extraction"
  };
}

const calendarTool: GateTool = {
  moduleId: "calendar",
  moduleDescription: "Calendar",
  name: "calendar.listVisibleEvents",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: { window: { type: "string", enum: ["today", "tomorrow"] } },
    required: ["window"]
  },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  classifier: {
    description: "Read the calendar",
    arguments: { window: { kind: "enum" } },
    replyTemplate: "{summary}"
  }
};

function calendarAnswers(choose: ReturnType<typeof vi.fn>): void {
  choose.mockImplementation(
    async (_handle: unknown, input: { question: { criteria: Record<string, string> } }) => {
      const keys = Object.keys(input.question.criteria);
      if (keys.includes("calendar")) return pick("calendar");
      if (keys.includes("calendar.listVisibleEvents")) return pick("calendar.listVisibleEvents");
      if (keys.includes("today")) return pick("today");
      return pick("none");
    }
  );
}

interface Harness {
  readonly runner: ReturnType<typeof createClassifierGateShadowRunner>;
  readonly choose: ReturnType<typeof vi.fn>;
  readonly open: ReturnType<typeof vi.fn>;
  readonly complete: ReturnType<typeof vi.fn>;
  readonly observeModelTool: ReturnType<typeof vi.fn>;
  readonly mint: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
  readonly resolve: ReturnType<typeof vi.fn>;
  readonly onFailure: ReturnType<typeof vi.fn>;
}

function harness(
  overrides: {
    mode?: string;
    chooseImpl?: ReturnType<typeof vi.fn>;
    open?: ReturnType<typeof vi.fn>;
    complete?: ReturnType<typeof vi.fn>;
    now?: () => number;
    gateway?: GatewayGateOutcome;
    listTools?: ClassifierGateAttemptPorts["listTools"];
    listToolNames?: readonly string[];
    speed?: GateSpeed;
  } = {}
): Harness {
  const choose = overrides.chooseImpl ?? vi.fn();
  if (!overrides.chooseImpl) calendarAnswers(choose);
  const resolve = vi.fn(async () => handle());
  const ports: ClassifierGateAttemptPorts = {
    classifier: {
      resolve,
      choose: choose as never,
      extract: vi.fn()
    },
    listTools: overrides.listTools ?? vi.fn(async () => [calendarTool]),
    loadCandidates: vi.fn(),
    isReleased: vi.fn(() => true),
    gateway: {
      call: vi.fn(
        async (): Promise<GatewayGateOutcome> =>
          overrides.gateway ?? { kind: "would_run", approvalMode: "auto" }
      )
    }
  };
  const createPorts: ClassifierGatePortsFactory = () => ports;

  const open = overrides.open ?? vi.fn(async () => true);
  const complete = overrides.complete ?? vi.fn(async () => true);
  const observeModelTool = vi.fn(async () => true);
  const repository = { open, complete, observeModelTool } as unknown as ClassifierShadowRepository;
  const mint = vi.fn(() => "jst_gate");
  const revoke = vi.fn();
  const onFailure = vi.fn();

  const deps: ClassifierGateShadowRunnerDeps = {
    readMode: vi.fn(async () => (overrides.mode ?? "shadow") as never),
    ...(overrides.speed ? { speed: overrides.speed } : {}),
    createPorts,
    repository,
    dataContext,
    tokens: { mint, revoke },
    listToolNames: vi.fn(async () => overrides.listToolNames ?? ["calendar.listVisibleEvents"]),
    thresholdVersion: "v1",
    onFailure,
    now: overrides.now ?? (() => 1_000_000)
  };
  return {
    runner: createClassifierGateShadowRunner(deps),
    choose,
    open,
    complete,
    observeModelTool,
    mint,
    revoke,
    resolve,
    onFailure
  };
}

function input(turnId = "turn-1") {
  return {
    actorUserId: "user-1",
    threadId: "thread-1",
    surface: normalizeChatSurface("drawer"),
    message: "what is on my calendar today",
    turnId,
    hasAttachment: false,
    incognito: false,
    signal: new AbortController().signal
  };
}

/**
 * Lets every pending microtask in a fire-and-forget attempt drain, so a "did nothing" assertion is
 * not just winning a race on the first await. With the private-chat guard removed this is what makes
 * the test fail on `open`/`resolve` rather than pass by timing.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("no-shadow cases make no classifier request", () => {
  it("off makes no classifier call and opens no record", async () => {
    const h = harness({ mode: "off" });
    h.runner.start(input());
    await settle();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("on is not the shadow runner's job", async () => {
    const h = harness({ mode: "on" });
    h.runner.start(input());
    await settle();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("a private turn is never classified and gets no record", async () => {
    const h = harness();
    h.runner.start({ ...input(), incognito: true });
    await settle();
    // The guard is the privacy boundary: with the incognito check removed the attempt reaches
    // `resolve`/`open`; observed failing that way, then restored.
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("an already-aborted turn does nothing", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    h.runner.start({ ...input(), signal: controller.signal });
    await settle();
    expect(h.open).not.toHaveBeenCalled();
  });

  it("an oversize multibyte message never opens a record or reaches the classifier", async () => {
    const h = harness();
    h.runner.start({ ...input(), message: "é".repeat(1_001) });
    await settle();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.mint).not.toHaveBeenCalled();
  });
});

describe("gate quick checks still decline", () => {
  it("an attachment is recorded as an attachment decline with no classifier request", async () => {
    const h = harness();
    h.runner.start({ ...input(), hasAttachment: true });
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    expect(h.complete).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ decision: "declined", reason: "attachment" })
    );
    expect(h.choose).not.toHaveBeenCalled();
  });
});

describe("shadow decisions", () => {
  it("records a would-handle decision and revokes the gate token", async () => {
    const h = harness();
    h.runner.start(input());
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    expect(h.open).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ turnId: "turn-1", classifierConfigId: "p1" })
    );
    expect(h.complete).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        turnId: "turn-1",
        decision: "would_handle",
        moduleId: "calendar",
        // The 3.4 record stores module_id + a bare tool name; the comparison identity is their join.
        toolName: "listVisibleEvents"
      })
    );
    expect(h.mint).toHaveBeenCalledWith("user-1", "turn-1", "thread-1", expect.any(Set));
    expect(h.revoke).toHaveBeenCalledWith("turn-1");
  });

  it("maps a missing classifier to no_classifier (a decline), not an error", async () => {
    const h = harness();
    h.resolve.mockResolvedValueOnce(null);
    h.runner.start(input());
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    expect(h.complete).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ decision: "declined", reason: "no_classifier" })
    );
  });
});

describe("correlation buffering", () => {
  it("buffers the model's first tool until the record exists, then writes it normalized", async () => {
    const h = harness();
    h.runner.start(input());
    // Buffered: `open` has not resolved yet when the observation arrives.
    h.runner.observeModelTool("user-1", "turn-1", "mcp__jarvis__calendar_listVisibleEvents");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", {
      kind: "tool",
      toolId: "calendar.listVisibleEvents"
    });
  });

  it("keeps only the first tool observation", async () => {
    const h = harness();
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", "mcp__jarvis__calendar_listVisibleEvents");
    h.runner.observeModelTool("user-1", "turn-1", "mcp__jarvis__tasks_create");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledTimes(1);
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", {
      kind: "tool",
      toolId: "calendar.listVisibleEvents"
    });
  });

  it.each([
    "mcp__jarvis__calendar_listVisibleEvents",
    "mcp__moss__calendar_listVisibleEvents",
    "calendar.listVisibleEvents"
  ])("names the classifier tool the transport called %s", async (raw) => {
    const h = harness();
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", raw);
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", {
      kind: "tool",
      toolId: "calendar.listVisibleEvents"
    });
  });

  it("names a tool reported after the record has opened", async () => {
    const h = harness();
    h.runner.start(input());
    await vi.waitFor(() => expect(h.open).toHaveBeenCalled());
    await settle();
    h.runner.observeModelTool("user-1", "turn-1", "mcp__moss__calendar_listVisibleEvents");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", {
      kind: "tool",
      toolId: "calendar.listVisibleEvents"
    });
  });

  it("stores no name when the model's tool is outside the classifier (a kept-out tool)", async () => {
    const h = harness({
      listToolNames: ["calendar.listVisibleEvents", "new-smart-hub.list_devices"]
    });
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", "mcp__jarvis__new-smart-hub_list_devices");
    h.runner.observeModelTool("user-1", "turn-1", "mcp__jarvis__calendar_listVisibleEvents");
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    await settle();
    expect(h.observeModelTool).toHaveBeenCalledTimes(1);
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", { kind: "unobserved" });
    expect(JSON.stringify(h.observeModelTool.mock.calls)).not.toContain("devices");
  });

  it("stores no name when the tool list could not be read", async () => {
    const h = harness({ listTools: vi.fn(async () => Promise.reject(new Error("down"))) });
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", "mcp__jarvis__calendar_listVisibleEvents");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", { kind: "unobserved" });
  });

  it("stores no name for a tool that no longer declares itself to the classifier", async () => {
    const { classifier: _dropped, ...undeclared } = calendarTool;
    const h = harness({ listTools: vi.fn(async () => [undeclared]) });
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", "mcp__moss__calendar_listVisibleEvents");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", { kind: "unobserved" });
  });

  it("stores no name when a kept-out tool's name encodes the same as a classifier tool", async () => {
    const turnOn: GateTool = { ...calendarTool, moduleId: "hub", name: "hub.turn_on" };
    const h = harness({
      listTools: vi.fn(async () => [turnOn]),
      listToolNames: ["hub.turn_on", "hub.turn.on"]
    });
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", "mcp__moss__hub_turn_on");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", { kind: "unobserved" });
    expect(JSON.stringify(h.observeModelTool.mock.calls)).not.toContain("hub");
  });

  it("keeps a connected tool's real name and connection", async () => {
    const hubTool: GateTool = {
      ...calendarTool,
      moduleId: "integration-new-smart-hub",
      name: "new-smart-hub.list_devices"
    };
    const h = harness({
      listTools: vi.fn(async () => [calendarTool, hubTool]),
      listToolNames: ["calendar.listVisibleEvents", "new-smart-hub.list_devices"]
    });
    h.runner.start(input());
    h.runner.observeModelTool("user-1", "turn-1", "mcp__moss__new-smart-hub_list_devices");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", {
      kind: "tool",
      toolId: "integration-new-smart-hub.new-smart-hub.list_devices"
    });
  });

  it("records no-model-tool when the turn ends without a tool call", async () => {
    const h = harness();
    h.runner.start(input());
    h.runner.noModelTool("user-1", "turn-1");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", { kind: "no_model_tool" });
  });

  it("records cancellation distinctly", async () => {
    const h = harness();
    h.runner.start(input());
    h.runner.cancelTurn("user-1", "turn-1");
    await vi.waitFor(() => expect(h.observeModelTool).toHaveBeenCalled());
    expect(h.observeModelTool).toHaveBeenCalledWith(fakeDb, "turn-1", { kind: "cancelled" });
  });
});

describe("failure and cooldown", () => {
  it("maps a classifier error to a failed decision", async () => {
    const choose = vi.fn().mockRejectedValue(new Error("boom"));
    const h = harness({ chooseImpl: choose });
    h.runner.start(input());
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    expect(h.complete).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ decision: "failed", reason: "classifier_error" })
    );
  });

  it("declines the next turn inside the cooldown without a second classifier request", async () => {
    let now = 1_000_000;
    const choose = vi.fn().mockRejectedValue(new Error("boom"));
    const h = harness({ chooseImpl: choose, now: () => now });
    h.runner.start(input("turn-1"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(1));

    now += 1_000; // inside the 30s window
    h.runner.start(input("turn-2"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledTimes(2));
    expect(h.complete).toHaveBeenLastCalledWith(
      fakeDb,
      expect.objectContaining({ turnId: "turn-2", decision: "declined", reason: "cooling_off" })
    );
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("maps a deadline timeout to a failed decision and starts the cooldown", async () => {
    vi.useFakeTimers();
    const choose = vi.fn(() => new Promise<never>(() => {}));
    const h = harness({ chooseImpl: choose });
    h.runner.start(input());
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.deadlineMs);
    await vi.runAllTimersAsync();
    expect(h.complete).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ decision: "failed", reason: "timeout" })
    );
  });

  it("waits out a five-second answer when the speed record allows it, and measures it (#3365)", async () => {
    vi.useFakeTimers();
    const choose = vi.fn();
    calendarAnswers(choose);
    const answer = choose.getMockImplementation()!;
    choose.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((resolve) => setTimeout(() => resolve(answer(...args)), 5_000))
    );
    const speed = new GateSpeedRecord();
    const record = vi.spyOn(speed, "record");
    const h = harness({ chooseImpl: choose, speed, now: () => Date.now() });
    h.runner.start(input());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.runAllTimersAsync();
    expect(h.complete).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ decision: "would_handle" })
    );
    expect(record).toHaveBeenCalledWith(handle().model.id, 5_000);
  });

  it("never throws when the repository write fails", async () => {
    const h = harness({ open: vi.fn(async () => false) });
    expect(() => h.runner.start(input())).not.toThrow();
    await Promise.resolve();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("reports storage failures without throwing into the turn", async () => {
    const complete = vi.fn(async () => {
      throw new Error("storage down");
    });
    const h = harness({ complete });
    h.runner.start(input());
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    expect(h.onFailure).toHaveBeenCalledWith("complete");
  });
});
