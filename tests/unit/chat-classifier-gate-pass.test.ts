import { describe, expect, it, vi } from "vitest";

import { SessionTokenRegistry, type ClassifierChoiceResult } from "@moss/ai";
import {
  buildClassifierGateRunner,
  GatePasses
} from "../../packages/chat/src/live/classifier-gate-runner.js";
import type { GateTool } from "../../packages/chat/src/live/classifier-gate-arguments.js";

/**
 * The On-mode gate pass: it starts with an empty tool list, gains exactly the one tool the gate
 * dispatches, and refuses any other tool. The fake gateway applies the same allowlist check the
 * real gateway applies (`prepareCall` in packages/ai/src/gateway/gateway.ts) against the real
 * `SessionTokenRegistry`, so the pass the runner minted is what decides.
 */

const ACTOR = "11111111-1111-1111-1111-111111111111";
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

function rig() {
  const tokens = new SessionTokenRegistry();
  const calls: string[] = [];
  const runner = buildClassifierGateRunner({
    readMode: async () => "on",
    tokens,
    createPorts: (_actor, passToken) => ({
      classifier: {
        resolve: async () => ({
          model: {
            id: "m1",
            provider_config_id: "p",
            provider_kind: "x",
            provider_model_id: "m"
          },
          capability: "choice_only"
        }),
        choose: vi
          .fn()
          .mockResolvedValueOnce(pick("calendar"))
          .mockResolvedValueOnce(pick("calendar.today")),
        extract: vi.fn()
      } as never,
      listTools: async () => [lookup],
      loadCandidates: async () => [],
      isReleased: () => true,
      gateway: {
        // The same check `prepareCall` makes against the pass the runner minted.
        call: async (toolName) => {
          const { allowedToolNames } = tokens.verify(passToken);
          if (allowedToolNames !== null && !allowedToolNames.has(toolName))
            return { kind: "declined", reason: "not_in_allowlist" };
          calls.push(toolName);
          return {
            kind: "executed",
            outcome: "success",
            response: { ok: true, data: {}, structuredData: { summary: "3 events" } }
          };
        }
      }
    }),
    now: () => Date.now()
  });
  return { runner, calls };
}

const REQUEST = {
  actorUserId: ACTOR,
  message: "What is on today?",
  mode: "on" as const,
  turnId: "t1"
};

describe("the gate pass", () => {
  it("lets the gate run the one tool it picked", async () => {
    const { runner, calls } = rig();
    const outcome = await runner.evaluate(REQUEST as never);
    expect(outcome.kind).toBe("handled");
    expect(calls).toEqual(["calendar.today"]);
  });

  it("declines when the runner has no ports to build a pass for", async () => {
    const runner = buildClassifierGateRunner({
      readMode: async () => "on",
      tokens: new SessionTokenRegistry(),
      now: () => Date.now()
    });
    expect((await runner.evaluate(REQUEST as never)).kind).toBe("declined");
  });
});

describe("the pass list", () => {
  it("accepts the first name and refuses a second, different name", () => {
    const passes = new GatePasses();
    const allowed = new Set<string>();
    passes.open("a1", allowed);

    expect(passes.permit("a1", "lock.unlock")).toBe(true);
    expect(passes.permit("a1", "tasks.delete")).toBe(false);
    expect(passes.permit("a1", "lock.unlock")).toBe(true);
    expect([...allowed]).toEqual(["lock.unlock"]);
  });

  it("refuses every name on a pass that was never opened or has been closed", () => {
    const passes = new GatePasses();
    expect(passes.permit("none", "lock.unlock")).toBe(false);

    passes.open("a2", new Set());
    passes.close("a2");
    expect(passes.has("a2")).toBe(false);
    expect(passes.permit("a2", "lock.unlock")).toBe(false);
  });
});
