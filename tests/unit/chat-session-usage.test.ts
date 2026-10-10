import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SESSION_BUDGET_TOKENS,
  createSessionUsage,
  getSessionBudgetTokens,
  noteSessionOutput,
  noteSessionSubmission,
  noteSessionTurnUsage,
  sessionNeedsRollover
} from "../../packages/chat/src/live/chat-session-usage.js";
import { estimateTokens } from "../../packages/chat/src/live/recall-seed.js";

// #3157: the app keeps its own conservative count of what one provider session has been fed
// and has produced, because provider usage is optional and is not context occupancy.

afterEach(() => vi.unstubAllEnvs());

const words = (n: number) => "word ".repeat(n);

describe("session budget setting (#3157)", () => {
  it("defaults to 64000 tokens", () => {
    expect(DEFAULT_SESSION_BUDGET_TOKENS).toBe(64_000);
    expect(getSessionBudgetTokens()).toBe(64_000);
  });

  it("reads a positive override and ignores anything else", () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", "3000");
    expect(getSessionBudgetTokens()).toBe(3000);
    for (const bad of ["0", "-5", "lots", ""]) {
      vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", bad);
      expect(getSessionBudgetTokens()).toBe(64_000);
    }
  });
});

describe("session usage count (#3157)", () => {
  it("counts the launch input: persona and replay", () => {
    const usage = createSessionUsage(["persona text", words(100)]);
    expect(usage.tokens).toBe(estimateTokens("persona text") + estimateTokens(words(100)));
    expect(usage.turnsSinceLaunch).toBe(0);
  });

  it("counts prepared turns and hidden context submissions", () => {
    const usage = createSessionUsage([]);
    noteSessionSubmission(usage, words(50), "context");
    expect(usage.turnsSinceLaunch).toBe(0);
    noteSessionSubmission(usage, words(80), "turn");
    expect(usage.turnsSinceLaunch).toBe(1);
    expect(usage.tokens).toBe(estimateTokens(words(50)) + estimateTokens(words(80)));
  });

  it("counts tool output and replies the model produced", () => {
    const usage = createSessionUsage([]);
    noteSessionSubmission(usage, "hi", "turn");
    const before = usage.tokens;
    noteSessionOutput(usage, { kind: "tool", toolName: "search", text: words(400) });
    noteSessionOutput(usage, { kind: "reply", text: words(20) });
    expect(usage.tokens - before).toBe(estimateTokens(words(400)) + estimateTokens(words(20)));
  });

  it("counts a live replacement record once, at its largest size", () => {
    const usage = createSessionUsage([]);
    noteSessionSubmission(usage, "hi", "turn");
    const before = usage.tokens;
    noteSessionOutput(usage, { kind: "thought", id: "t1", text: words(10) });
    noteSessionOutput(usage, { kind: "thought", id: "t1", text: words(30) });
    noteSessionOutput(usage, { kind: "thought", id: "t1", text: words(30) });
    expect(usage.tokens - before).toBe(estimateTokens(words(30)));
  });

  it("falls back to the estimate when a turn reports no usage", () => {
    const usage = createSessionUsage([]);
    noteSessionSubmission(usage, "hi", "turn");
    noteSessionOutput(usage, { kind: "reply", text: words(20) });
    const before = usage.tokens;
    noteSessionTurnUsage(usage, undefined);
    noteSessionTurnUsage(usage, {});
    expect(usage.tokens).toBe(before);
  });

  it("lets reported output raise the count but never lower it", () => {
    const usage = createSessionUsage([]);
    noteSessionSubmission(usage, "hi", "turn");
    noteSessionOutput(usage, { kind: "reply", text: words(20) });
    const before = usage.tokens;
    noteSessionTurnUsage(usage, { outputTokens: 1, inputTokens: 900_000 });
    expect(usage.tokens).toBe(before);
    noteSessionTurnUsage(usage, { outputTokens: 400, thoughtTokens: 100 });
    expect(usage.tokens).toBe(before - estimateTokens(words(20)) + 500);
  });
});

describe("rollover decision (#3157)", () => {
  it("rolls over only when the next turn would pass the budget", () => {
    const usage = createSessionUsage([words(100)]);
    noteSessionSubmission(usage, words(100), "turn");
    expect(sessionNeedsRollover(usage, estimateTokens(words(10)), 10_000)).toBe(false);
    expect(sessionNeedsRollover(usage, estimateTokens(words(10)), usage.tokens)).toBe(true);
  });

  it("never rolls over a session that has not taken a turn yet", () => {
    const usage = createSessionUsage([words(5000)]);
    expect(sessionNeedsRollover(usage, 10, 100)).toBe(false);
  });

  it("never rolls over a session without a usage count", () => {
    expect(sessionNeedsRollover(undefined, 10, 1)).toBe(false);
  });
});
