import { describe, expect, it } from "vitest";

import { pickCheapestActiveChatModel, type UatDiscoveredModel } from "./model-tier.js";

function model(overrides: Partial<UatDiscoveredModel> = {}): UatDiscoveredModel {
  return {
    id: "some-model",
    status: "active",
    capabilities: ["chat"],
    tier: "economy",
    ...overrides
  };
}

describe("pickCheapestActiveChatModel (#2732)", () => {
  it("pins the requested provider model within the economy tier", () => {
    const pinned = model({ providerModelId: "gpt-6-luna" });
    expect(
      pickCheapestActiveChatModel(
        [model({ providerModelId: "gpt-5.6-luna" }), pinned],
        "gpt-6-luna"
      )
    ).toBe(pinned);
  });

  it.each([
    model({ providerModelId: "gpt-5.6-luna" }),
    model({ providerModelId: "gpt-6-luna", tier: "reasoning" }),
    model({ providerModelId: "gpt-6-luna", status: "disabled" })
  ])("refuses fallback when a requested model is unavailable or ineligible", (candidate) => {
    expect(() => pickCheapestActiveChatModel([candidate], "gpt-6-luna")).toThrow();
  });

  it("picks the active, chat-capable, economy-tier model", () => {
    const economy = model({ id: "gpt-6-luna", tier: "economy" });
    const picked = pickCheapestActiveChatModel([
      model({ id: "gpt-6-sol", tier: "reasoning" }),
      economy,
      model({ id: "gpt-6-terra", tier: "interactive" })
    ]);
    expect(picked).toBe(economy);
  });

  it("ignores an economy-tier model that is disabled", () => {
    expect(() =>
      pickCheapestActiveChatModel([model({ status: "disabled", tier: "economy" })])
    ).toThrow(/no active, chat-capable, economy-tier model/);
  });

  it("ignores an economy-tier model without chat capability", () => {
    expect(() =>
      pickCheapestActiveChatModel([model({ capabilities: ["structured"], tier: "economy" })])
    ).toThrow(/no active, chat-capable, economy-tier model/);
  });

  it("never falls back to a pricier tier when no economy model is eligible", () => {
    expect(() =>
      pickCheapestActiveChatModel([
        model({ id: "gpt-6-sol", tier: "reasoning" }),
        model({ id: "gpt-6-terra", tier: "interactive" })
      ])
    ).toThrow(/no active, chat-capable, economy-tier model/);
  });

  it("throws a clear message (naming the model count) when discovery found nothing at all", () => {
    expect(() => pickCheapestActiveChatModel([])).toThrow(/found 0 model\(s\) total/);
  });
});
