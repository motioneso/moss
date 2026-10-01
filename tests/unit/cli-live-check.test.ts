import { describe, expect, it, vi } from "vitest";

import { isValidSumReply, runLiveCheckSteps } from "../../packages/ai/src/cli-live-check.js";

const ok = (replyText = "") => ({ ok: true as const, replyText });

describe("isValidSumReply", () => {
  it("accepts the object bare or fenced, and nothing else", () => {
    expect(isValidSumReply('{"sum":4}')).toBe(true);
    expect(isValidSumReply('```json\n{"sum": 4}\n```')).toBe(true);
    expect(isValidSumReply('{"sum":5}')).toBe(false);
    expect(isValidSumReply('{"sum":4,"extra":1}')).toBe(false);
    expect(isValidSumReply("[4]")).toBe(false);
    expect(isValidSumReply("The answer is 4")).toBe(false);
  });
});

describe("runLiveCheckSteps", () => {
  it("passes when the tool call happened and the object is valid on the first try", async () => {
    const r = await runLiveCheckSteps({
      toolTurn: async () => ok(),
      structuredTurn: async () => ok('{"sum":4}')
    });
    expect(r).toEqual({ passed: true, reason: "ok", attempts: 1 });
  });

  it("records a second try when the first object is invalid", async () => {
    const structuredTurn = vi
      .fn()
      .mockResolvedValueOnce(ok("nope"))
      .mockResolvedValue(ok('{"sum":4}'));
    const r = await runLiveCheckSteps({ toolTurn: async () => ok(), structuredTurn });
    expect(r).toEqual({ passed: true, reason: "ok", attempts: 2 });
  });

  it("fails after two bad objects", async () => {
    const r = await runLiveCheckSteps({
      toolTurn: async () => ok(),
      structuredTurn: async () => ok("nope")
    });
    expect(r).toEqual({ passed: false, reason: "structured_call_failed", attempts: 2 });
  });

  it("stops at the tool call when it is missing and never runs the second call", async () => {
    const structuredTurn = vi.fn();
    const r = await runLiveCheckSteps({
      toolTurn: async () => ({ ok: false, reason: "tool_call_missing" }),
      structuredTurn
    });
    expect(r).toEqual({ passed: false, reason: "tool_call_missing" });
    expect(structuredTurn).not.toHaveBeenCalled();
  });

  it("passes a timeout or an unavailable check straight through", async () => {
    const r = await runLiveCheckSteps({
      toolTurn: async () => ok(),
      structuredTurn: async () => ({ ok: false, reason: "timeout" })
    });
    expect(r).toEqual({ passed: false, reason: "timeout", attempts: 1 });
  });
});
