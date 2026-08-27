import { describe, expect, it } from "vitest";

import { CLI_STATIC_MODELS, DEFAULT_CHAT_MODELS, ModelDiscoveryService } from "@moss/ai";

describe("CLI model discovery (#982/#869)", () => {
  it("curates active-ready Codex ids with service tiers", async () => {
    const result = await new ModelDiscoveryService().discoverModels("codex", {
      providerKind: "openai-compatible",
      authMethod: "cli",
      baseUrl: null,
      credential: { cli: true }
    });

    expect(CLI_STATIC_MODELS["openai-compatible"]).toBeDefined();
    expect(
      Object.fromEntries(result.models.map((model) => [model.providerModelId, model.tier]))
    ).toMatchObject({
      "gpt-5.6-sol": "reasoning",
      "gpt-5.6-terra": "interactive",
      "gpt-5.6-luna": "economy"
    });
  });

  // #2028 — Google chat works now, so the Gemini models have to be listed. Before this, a signed-in
  // Google account offered nothing to pick and no default model was created on sign-in.
  it("curates Gemini ids with the tiers their names announce", async () => {
    const result = await new ModelDiscoveryService().discoverModels("gemini", {
      providerKind: "google",
      authMethod: "cli",
      baseUrl: null,
      credential: { cli: true }
    });

    expect(CLI_STATIC_MODELS.google).toBeDefined();
    expect(
      Object.fromEntries(result.models.map((model) => [model.providerModelId, model.tier]))
    ).toMatchObject({
      "gemini-3.1-pro-preview": "reasoning",
      "gemini-3-pro-preview": "reasoning",
      "gemini-3-flash-preview": "economy",
      "gemini-2.5-pro": "reasoning",
      "gemini-2.5-flash": "economy",
      "gemini-2.5-flash-lite": "economy"
    });
    // Every Gemini model reads pictures, so chat can accept an attached image on any of them.
    for (const model of result.models) expect(model.capabilities).toContain("vision");
  });

  it("registers a Gemini default model that rides the account's own model", () => {
    expect(DEFAULT_CHAT_MODELS.google).toMatchObject({
      providerModelId: "default",
      tier: "interactive",
      capabilities: ["chat"]
    });
  });
});
