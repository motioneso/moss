import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { GenerateStructuredDeps, GenerateStructuredResult } from "@moss/ai";
import { writeModuleBuildPlan } from "../../packages/ai/src/module-build/write-plan.js";

const scopedDb = {} as DataContextDb;
const generateStructuredDeps = {} as GenerateStructuredDeps;

const minimalPlan = {
  whatItDoes: "Shows a list.",
  whatItReaches: [],
  whatItKeeps: "Nothing.",
  whenItRuns: "On page load.",
  roughCost: { time: "a few minutes", budgetCents: 5 }
};

const minimalInput = { description: "show me a list", conversationExcerpt: "..." };

describe("writeModuleBuildPlan", () => {
  it("asks generateStructured for a plan and returns it in the five-line shape", async () => {
    const fullPlan = {
      whatItDoes: "Shows today's videos from two channels, embedded.",
      whatItReaches: ["YouTube's public feed for two channels"],
      whatItKeeps: "Nothing new — this build stores no data.",
      whenItRuns: "Checks for new videos every hour.",
      roughCost: { time: "about ten minutes", budgetCents: 20 }
    };
    const fakeGenerateStructured = vi.fn(
      async (): Promise<GenerateStructuredResult> => ({
        ok: true,
        object: fullPlan,
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    );

    const plan = await writeModuleBuildPlan(
      scopedDb,
      { generateStructured: fakeGenerateStructured, generateStructuredDeps },
      { description: "show me today's GMM videos", conversationExcerpt: "..." }
    );

    expect(plan.whatItReaches).toContain("YouTube's public feed for two channels");
    expect(fakeGenerateStructured).toHaveBeenCalledOnce();
    expect(fakeGenerateStructured).toHaveBeenCalledWith(
      scopedDb,
      expect.objectContaining({
        service: "module.workshop.plan",
        tierHint: "reasoning",
        requiredTier: "reasoning",
        sourceGeneration: true
      }),
      expect.objectContaining({ createCliStructuredAdapter: undefined })
    );
  });

  it("never names a specific AI provider or model in the call it makes", async () => {
    const fakeGenerateStructured = vi.fn(
      async (): Promise<GenerateStructuredResult> => ({
        ok: true,
        object: minimalPlan,
        usage: { inputTokens: 0, outputTokens: 0 }
      })
    );
    await writeModuleBuildPlan(
      scopedDb,
      { generateStructured: fakeGenerateStructured, generateStructuredDeps },
      minimalInput
    );
    const callArgs = fakeGenerateStructured.mock.calls[0];
    expect(JSON.stringify(callArgs)).not.toMatch(/gpt-|claude-|gemini-/i);
  });

  it("throws when generateStructured cannot produce a plan", async () => {
    const fakeGenerateStructured = vi.fn(
      async (): Promise<GenerateStructuredResult> => ({ ok: false, error: "needs_config" })
    );
    await expect(
      writeModuleBuildPlan(
        scopedDb,
        { generateStructured: fakeGenerateStructured, generateStructuredDeps },
        minimalInput
      )
    ).rejects.toThrow("/settings?section=aiproviders");
  });
});
