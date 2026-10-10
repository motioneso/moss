import { describe, expect, it } from "vitest";

import {
  PROMPT_ALLOWANCE_TOKENS,
  launchContextFits,
  planSummaryCoverage,
  splitAtSummaryFrontier
} from "../../packages/chat/src/live/summary-coverage.js";

function turn(id: string, content = `body ${id}`) {
  return {
    id,
    role: (Number(id.slice(1)) % 2 ? "user" : "assistant") as "user" | "assistant",
    content
  };
}

const history = Array.from({ length: 10 }, (_, i) => turn(`m${i + 1}`));

describe("splitAtSummaryFrontier", () => {
  it("returns every turn after the accepted frontier, with no gap", () => {
    const split = splitAtSummaryFrontier(history, {
      summary: "Decided: blue",
      coveredThroughMessageId: "m4",
      revision: 3
    });
    expect(split.summary).toBe("Decided: blue");
    expect(split.uncovered.map((m) => m.id)).toEqual(["m5", "m6", "m7", "m8", "m9", "m10"]);
  });

  it("ignores a legacy summary without a frontier and replays the whole history", () => {
    const split = splitAtSummaryFrontier(history, {
      summary: "As of turn 8: user: ...",
      coveredThroughMessageId: null,
      revision: 0
    });
    expect(split.summary).toBeNull();
    expect(split.uncovered).toHaveLength(10);
  });

  it("treats a frontier that no longer exists as unaccepted rather than dropping turns", () => {
    const split = splitAtSummaryFrontier(history, {
      summary: "Decided: blue",
      coveredThroughMessageId: "gone",
      revision: 2
    });
    expect(split.summary).toBeNull();
    expect(split.uncovered).toHaveLength(10);
  });
});

describe("planSummaryCoverage", () => {
  it("does nothing while the uncovered suffix is under both triggers", () => {
    expect(
      planSummaryCoverage(history.slice(0, 6), {
        keep: 4,
        replayTokens: 10_000,
        maxInputTokens: 10_000
      })
    ).toBeNull();
  });

  it("covers the older uncovered turns and keeps the newest raw", () => {
    const plan = planSummaryCoverage(history, {
      keep: 4,
      replayTokens: 10_000,
      maxInputTokens: 10_000
    });
    expect(plan?.cover.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(plan?.throughMessageId).toBe("m6");
  });

  it("triggers on tokens when a few long turns exceed half the replay budget", () => {
    const long = [turn("m1", "x".repeat(4000)), turn("m2", "y".repeat(4000)), turn("m3", "short")];
    const plan = planSummaryCoverage(long, {
      keep: 40,
      replayTokens: 2000,
      maxInputTokens: 10_000
    });
    expect(plan?.cover.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("caps one run's input and leaves the rest for the next run", () => {
    const plan = planSummaryCoverage(history, {
      keep: 2,
      replayTokens: 10_000,
      maxInputTokens: 12
    });
    expect(plan?.cover.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(plan?.throughMessageId).toBe("m2");
  });
});

describe("launchContextFits", () => {
  it("fits when seed, summary, replay and the prompt allowance stay inside the budget", () => {
    expect(
      launchContextFits(
        { seedTokens: 100, summaryTokens: 100, replayTokens: 500 },
        700 + PROMPT_ALLOWANCE_TOKENS
      )
    ).toBe(true);
  });

  it("refuses rather than truncating when the retained context is over budget", () => {
    expect(
      launchContextFits(
        { seedTokens: 100, summaryTokens: 100, replayTokens: 501 },
        700 + PROMPT_ALLOWANCE_TOKENS
      )
    ).toBe(false);
  });
});
