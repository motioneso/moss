import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SessionTokenRegistry,
  type ClassifierChoiceResult,
  type GatewayGateOutcome
} from "@moss/ai";

import {
  ClassifierGate,
  GATE_LIMITS,
  type ClassifierGatePorts,
  type GateRequest,
  type GateSpeed,
  type GateTool
} from "../../packages/chat/src/live/classifier-gate.js";
import {
  buildClassifierGateRunner,
  GATE_TOKEN_TTL_MS
} from "../../packages/chat/src/live/classifier-gate-runner.js";
import {
  GATE_TIME_LIMIT,
  GateSpeedRecord
} from "../../packages/chat/src/live/classifier-gate-speed.js";

/**
 * #3365: the gate's time limit follows each routing model's measured time per question. A fast
 * model keeps a tight limit, a slow one gets room for a full attempt, an unmeasured one gets the
 * ceiling, and timeouts count as slow answers.
 */

const MODEL_ID = "m1";
const usage = { inputTokens: 1, outputTokens: 1 };

function pick(choice: string): ClassifierChoiceResult {
  return {
    ok: true,
    choice,
    confidence: 0.99,
    probabilities: { [choice]: 0.9, other: 0.1 },
    runnerUp: { choice: "other", probability: 0.1 },
    lead: 0.8,
    usage
  };
}

const lookup: GateTool = {
  moduleId: "calendar",
  moduleDescription: "The user's calendar",
  name: "calendar.today",
  risk: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  classifier: { description: "List the day's events", replyTemplate: "Events: {summary}" }
};

/** The first answer lands after `answerMs`; the second is immediate. */
function slowChoose(answerMs: number) {
  return vi
    .fn()
    .mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(pick("calendar")), answerMs))
    )
    .mockResolvedValueOnce(pick("calendar.today"));
}

function attemptPorts(answerMs: number, resolveMs = 0) {
  const gatewayCall = vi.fn(
    async (): Promise<GatewayGateOutcome> => ({
      kind: "executed",
      outcome: "success",
      response: { ok: true, data: {}, structuredData: { summary: "3 events" } }
    })
  );
  return {
    gatewayCall,
    ports: {
      classifier: {
        resolve: async () => {
          if (resolveMs > 0) await new Promise((done) => setTimeout(done, resolveMs));
          return {
            model: {
              id: MODEL_ID,
              provider_config_id: "p",
              provider_kind: "x",
              provider_model_id: "m"
            },
            capability: "choice_only"
          };
        },
        choose: slowChoose(answerMs),
        extract: vi.fn()
      } as never as ClassifierGatePorts["classifier"],
      listTools: async () => [lookup],
      loadCandidates: async () => [],
      isReleased: () => true,
      gateway: { call: gatewayCall }
    }
  };
}

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    actorUserId: "user-1",
    threadId: "thread-1",
    message: "What is on today?",
    hasAttachment: false,
    incognito: false,
    mode: "on",
    ...overrides
  };
}

/** A record holding `count` attempts of `ms` per question each for the test model. */
function measured(ms: number, count = 5): GateSpeedRecord {
  const speed = new GateSpeedRecord();
  for (let i = 0; i < count; i += 1) speed.record(MODEL_ID, ms);
  return speed;
}

async function attempt(answerMs: number, speed?: GateSpeed) {
  vi.useFakeTimers();
  const { ports, gatewayCall } = attemptPorts(answerMs);
  const gate = new ClassifierGate({ ...ports, ...(speed ? { speed } : {}), now: () => Date.now() });
  const pending = gate.evaluate(request());
  await vi.advanceTimersByTimeAsync(answerMs);
  return { outcome: await pending, gatewayCall };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the speed record's limit", () => {
  it("keeps a fast model on the floor", () => {
    expect(measured(200).limitMs(MODEL_ID)).toBe(GATE_TIME_LIMIT.floorMs);
    expect(GATE_TIME_LIMIT.floorMs).toBe(GATE_LIMITS.deadlineMs);
  });

  it("stretches a slow model to twice a full attempt at its slow question time, plus the margin", () => {
    expect(GATE_TIME_LIMIT.questionsPerAttempt).toBe(4);
    expect(measured(1_500).limitMs(MODEL_ID)).toBe(12_500);
  });

  it("uses the 90th percentile, so one slow blip does not stretch a fast model", () => {
    const speed = measured(200, 19);
    speed.record(MODEL_ID, 9_000);
    expect(speed.limitMs(MODEL_ID)).toBe(GATE_TIME_LIMIT.floorMs);
  });

  it("uses the ceiling for a model with no record yet", () => {
    expect(new GateSpeedRecord().limitMs(MODEL_ID)).toBe(GATE_TIME_LIMIT.ceilingMs);
  });

  it("never goes past the ceiling", () => {
    expect(measured(60_000).limitMs(MODEL_ID)).toBe(GATE_TIME_LIMIT.ceilingMs);
  });

  it("keeps the ceiling at most half the gate token's fixed life", () => {
    expect(GATE_TIME_LIMIT.ceilingMs * 2).toBeLessThanOrEqual(GATE_TOKEN_TTL_MS);
  });

  it("keeps each model's record apart and drops the oldest past the window", () => {
    const speed = measured(6_000, GATE_TIME_LIMIT.samples);
    speed.record("other", 200);
    expect(speed.limitMs("other")).toBe(GATE_TIME_LIMIT.floorMs);
    for (let i = 0; i < GATE_TIME_LIMIT.samples; i += 1) speed.record(MODEL_ID, 200);
    expect(speed.limitMs(MODEL_ID)).toBe(GATE_TIME_LIMIT.floorMs);
  });
});

describe("the gate engine runs under the model's measured limit", () => {
  it("declines a five-second answer from a model measured as fast", async () => {
    const { outcome, gatewayCall } = await attempt(5_000, measured(200));
    expect(outcome).toMatchObject({ kind: "declined", reason: "timeout" });
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("runs a ten-second answer from a model measured as slow", async () => {
    const { outcome, gatewayCall } = await attempt(10_000, measured(1_500));
    expect(outcome.kind).toBe("handled");
    expect(gatewayCall).toHaveBeenCalled();
  });

  it("runs a twenty-five-second answer from a model with no record yet", async () => {
    const { outcome } = await attempt(25_000, new GateSpeedRecord());
    expect(outcome.kind).toBe("handled");
  });

  it("keeps the fixed limit when no speed record is wired", async () => {
    const { outcome } = await attempt(5_000);
    expect(outcome).toMatchObject({ kind: "declined", reason: "timeout" });
  });

  it("records each answered attempt's time per question against the model", async () => {
    const speed = new GateSpeedRecord();
    const record = vi.spyOn(speed, "record");
    const { outcome } = await attempt(4_000, speed);
    expect(outcome.kind).toBe("handled");
    expect(record).toHaveBeenCalledWith(MODEL_ID, 2_000);
  });

  it("counts the argument extract call as a question", async () => {
    vi.useFakeTimers();
    const addTask: GateTool = {
      moduleId: "tasks",
      moduleDescription: "The user's tasks",
      name: "tasks.create",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", maxLength: 100 } },
        required: ["title"],
        additionalProperties: false
      },
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      classifier: {
        description: "Add a task",
        arguments: { title: { kind: "extract" } },
        replyTemplate: "Added {summary}."
      }
    };
    const { ports } = attemptPorts(0);
    const extract = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, values: { title: "call mum" }, usage }), 3_000)
        )
    );
    const speed = new GateSpeedRecord();
    const record = vi.spyOn(speed, "record");
    const gate = new ClassifierGate({
      ...ports,
      classifier: {
        ...ports.classifier,
        resolve: async () => ({
          model: {
            id: MODEL_ID,
            provider_config_id: "p",
            provider_kind: "x",
            provider_model_id: "m"
          },
          capability: "typed_extraction"
        }),
        choose: vi
          .fn()
          .mockResolvedValueOnce(pick("tasks"))
          .mockResolvedValueOnce(pick("tasks.create")),
        extract
      } as never as ClassifierGatePorts["classifier"],
      listTools: async () => [addTask],
      speed,
      now: () => Date.now()
    });
    const pending = gate.evaluate(request());
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).kind).toBe("handled");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(MODEL_ID, 1_000);
  });

  it("counts the limit from the start of the attempt, not from when the model is found", async () => {
    vi.useFakeTimers();
    const { ports } = attemptPorts(1_500, 2_000);
    const gate = new ClassifierGate({ ...ports, speed: measured(200), now: () => Date.now() });
    const pending = gate.evaluate(request());
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await pending).toMatchObject({ kind: "declined", reason: "timeout" });
  });

  it("records a timeout as the time allowed, so the limit grows", async () => {
    const speed = measured(200, 1);
    const record = vi.spyOn(speed, "record");
    await attempt(5_000, speed);
    expect(record).toHaveBeenLastCalledWith(MODEL_ID, GATE_TIME_LIMIT.floorMs);
    expect(speed.limitMs(MODEL_ID)).toBe(
      GATE_TIME_LIMIT.floorMs * GATE_TIME_LIMIT.questionsPerAttempt * 2 + GATE_TIME_LIMIT.marginMs
    );
  });

  it("lets a model that keeps timing out climb to an answer", async () => {
    const speed = measured(200, 1);
    let outcome = (await attempt(10_000, speed)).outcome;
    for (let tries = 0; outcome.kind !== "handled" && tries < 3; tries += 1) {
      outcome = (await attempt(10_000, speed)).outcome;
    }
    expect(outcome.kind).toBe("handled");
  });

  it("records nothing when the user cancels the turn", async () => {
    vi.useFakeTimers();
    const speed = new GateSpeedRecord();
    const record = vi.spyOn(speed, "record");
    const { ports } = attemptPorts(5_000);
    const gate = new ClassifierGate({ ...ports, speed, now: () => Date.now() });
    const turn = new AbortController();
    const pending = gate.evaluate(request({ signal: turn.signal }));
    await vi.advanceTimersByTimeAsync(1_000);
    turn.abort();
    expect((await pending).kind).toBe("cancelled");
    expect(record).not.toHaveBeenCalled();
  });

  it("records nothing when the model is resolved but no question reaches it", async () => {
    vi.useFakeTimers();
    const speed = measured(200, 1);
    const record = vi.spyOn(speed, "record");
    const { ports } = attemptPorts(5_000);
    const resolve = vi.spyOn(ports.classifier, "resolve");
    const gate = new ClassifierGate({ ...ports, speed, now: () => Date.now() });
    const first = gate.evaluate(request());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toMatchObject({ reason: "timeout" });
    expect(record).toHaveBeenCalledTimes(1);

    expect(await gate.evaluate(request())).toMatchObject({ reason: "cooling_off" });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe("the live gate runner passes the speed record to every attempt", () => {
  function runner(speed?: GateSpeed) {
    const { ports } = attemptPorts(10_000);
    return buildClassifierGateRunner({
      readMode: async () => "on",
      ...(speed ? { speed } : {}),
      tokens: new SessionTokenRegistry(),
      createPorts: () => ports,
      now: () => Date.now()
    });
  }

  it("runs a ten-second answer from a model measured as slow", async () => {
    vi.useFakeTimers();
    const pending = runner(measured(1_500)).evaluate(request());
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).kind).toBe("handled");
  });

  it("declines the same answer without a record wired", async () => {
    vi.useFakeTimers();
    const pending = runner().evaluate(request());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ kind: "declined", reason: "timeout" });
  });
});
