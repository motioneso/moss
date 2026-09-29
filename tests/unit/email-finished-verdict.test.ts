import { describe, expect, it } from "vitest";

import { applyGate } from "../../packages/connectors/src/email-gate.js";
import type { EmailExtractResult } from "../../packages/connectors/src/email-extract.js";
import { hasFinishedVerdict } from "../../packages/email/src/repository.js";

const source = { subject: "Weekly deals", body: "Save 20% on everything in store this week only." };

function gated(result: EmailExtractResult): EmailExtractResult {
  return applyGate(result, false, source);
}

describe("hasFinishedVerdict (#2804)", () => {
  it("counts the gate's junk verdict as finished even though it saves no summary", () => {
    const junk = gated({ gate: "nothing", summary: "ignored", signals: { confidence: 0.9 } });
    expect(junk.summary).toBeNull();
    expect(hasFinishedVerdict(junk.summary, junk.signals)).toBe(true);
  });

  it("counts a message handed to the thread judgement as finished", () => {
    const owed = gated({
      gate: "maybe_owed",
      summary: null,
      signals: { actionability: { category: "needs_reply", reason: "Asked a question." } }
    });
    expect(owed.summary).toBeNull();
    expect(hasFinishedVerdict(owed.summary, owed.signals)).toBe(true);
  });

  it("counts a worth-knowing summary as finished", () => {
    const fyi = gated({ gate: "worth_knowing", summary: "Store sale.", signals: {} });
    expect(hasFinishedVerdict(fyi.summary, fyi.signals)).toBe(true);
  });

  it("leaves a reply that failed to parse open for a retry", () => {
    expect(
      hasFinishedVerdict(null, { billsDue: [], actionItems: [], deadlines: [], confidence: 0 })
    ).toBe(false);
  });

  it("leaves a message that never reached the model open for a retry", () => {
    expect(hasFinishedVerdict(null, {})).toBe(false);
    expect(hasFinishedVerdict(null, { confidence: 0 })).toBe(false);
  });

  it("leaves actionable triage without a subject or task open for a retry", () => {
    expect(
      hasFinishedVerdict("Reply needed.", {
        actionability: { category: "needs_reply", reason: "Asked a question." }
      })
    ).toBe(false);
  });

  it("does not count an unknown category as finished", () => {
    expect(hasFinishedVerdict(null, { actionability: { category: "unknown" } })).toBe(false);
    expect(hasFinishedVerdict("Summary.", { actionability: { category: "unknown" } })).toBe(false);
  });
});
