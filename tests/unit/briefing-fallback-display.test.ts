import { describe, expect, it } from "vitest";

import { composeBriefing } from "../../packages/briefings/src/compose.js";
import { fallbackEvening } from "../../packages/briefings/src/compose-evening.js";
import { displaySummaryText, isFallbackRun } from "../../packages/briefings/src/run-display.js";
import {
  definition,
  fakeScopedDb,
  makeFakeDeps,
  runInput,
  type FakeOptions
} from "./briefings-compose.harness.js";

// The Today hero and the briefing reader render only a non-empty summary, so an empty
// API summary is what keeps the fallback digest off every surface.
describe("fallback briefing runs never reach the UI", () => {
  const fallbackCases: ReadonlyArray<[string, FakeOptions]> = [
    ["no model is configured", { noModel: true }],
    [
      "synthesis throws",
      {
        generateChat: async () => {
          throw new Error("provider down");
        }
      }
    ],
    ["the AI credential is malformed", { credentialPayload: { token: "bad" } }]
  ];

  it.each(fallbackCases)("hides the morning digest when %s", async (_label, options) => {
    const result = await composeBriefing(
      fakeScopedDb,
      definition(),
      runInput,
      makeFakeDeps(options)
    );

    expect(result.summaryText).toContain("COMMITMENTS");
    expect(isFallbackRun(result.sourceMetadata)).toBe(true);
    expect(displaySummaryText(result.summaryText, result.sourceMetadata)).toBe("");
  });

  it("hides the evening digest", () => {
    const result = fallbackEvening({
      reason: "no_model",
      completed: ["Shipped the thing"],
      slipped: [],
      carrying: [],
      attention: [],
      tomorrow: [],
      newsSports: [],
      metadata: {},
      structuredPayload: { version: 1, actionRows: [], catchUp: null }
    });

    expect(isFallbackRun(result.sourceMetadata)).toBe(true);
    expect(displaySummaryText(result.summaryText, result.sourceMetadata)).toBe("");
  });

  it("keeps an AI-written briefing", async () => {
    const result = await composeBriefing(fakeScopedDb, definition(), runInput, makeFakeDeps());

    expect(result.sourceMetadata.aiModel).not.toBeNull();
    expect(displaySummaryText(result.summaryText, result.sourceMetadata)).toBe(result.summaryText);
  });

  it("keeps an AI-written briefing that read a source from cache", () => {
    const metadata = {
      degraded: true,
      aiModel: { id: "model-1", displayName: "Model", tier: "economy" }
    };

    expect(isFallbackRun(metadata)).toBe(false);
    expect(displaySummaryText("Quiet morning.", metadata)).toBe("Quiet morning.");
  });
});
