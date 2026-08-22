import { describe, expect, it, vi } from "vitest";

import {
  classifyDraftChangeRequest,
  type ModuleBuildPlan
} from "../../packages/ai/src/module-build/classify-draft-change.js";

const currentPlan: ModuleBuildPlan = {
  whatItDoes: "Shows today's videos from two channels, embedded.",
  whatItReaches: ["YouTube's public feed for two channels"],
  whatItKeeps: "Nothing.",
  whenItRuns: "Checks for new videos every hour.",
  roughCost: { time: "about ten minutes", budgetCents: 20 }
};

describe("classifyDraftChangeRequest", () => {
  it("classifies a looks-only request as cosmetic when the revised plan reaches nothing new", async () => {
    const getCurrentPlan = vi.fn().mockResolvedValue(currentPlan);
    const writeModuleBuildPlan = vi.fn().mockResolvedValue(currentPlan);

    const result = await classifyDraftChangeRequest(
      { getCurrentPlan, writeModuleBuildPlan },
      "build_1",
      "make the thumbnails bigger"
    );

    expect(result).toEqual({ kind: "cosmetic" });
  });

  it("classifies a request naming a new outside service as new-external-service, with a plan whose whatItReaches includes it", async () => {
    const getCurrentPlan = vi.fn().mockResolvedValue(currentPlan);
    const writeModuleBuildPlan = vi.fn().mockResolvedValue({
      ...currentPlan,
      whatItReaches: [...currentPlan.whatItReaches, "Discord's announcements channel"]
    });

    const result = await classifyDraftChangeRequest(
      { getCurrentPlan, writeModuleBuildPlan },
      "build_1",
      "also show the Discord announcements"
    );

    expect(result.kind).toBe("new-external-service");
    if (result.kind !== "new-external-service") throw new Error("expected new-external-service");
    expect(result.plan.whatItReaches).toContain("Discord's announcements channel");
    expect(writeModuleBuildPlan).toHaveBeenCalledOnce();
  });
});
