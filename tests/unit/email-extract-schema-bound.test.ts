import { describe, expect, it, vi } from "vitest";

import { buildEmailExtractDeps } from "../../packages/connectors/src/extract-deps.js";

const value = {
  gate: "maybe_owed",
  category: "needs_action",
  reason: "A synthetic action is required.",
  action: "Complete the synthetic action",
  confidence: 0.5
};

describe("email extraction structured schema", () => {
  it("accepts the exact 21-result batch schema before invoking the provider", async () => {
    const generateStructured = vi.fn(async () => ({
      rawObject: {
        results: Array.from({ length: 21 }, (_, index) => ({ index, value }))
      },
      usage: { inputTokens: 0, outputTokens: 0 }
    }));
    const deps = buildEmailExtractDeps(
      {} as never,
      {
        resolveModelForService: async () => ({
          model: {
            id: "synthetic-model",
            provider_config_id: "synthetic-provider",
            provider_kind: "anthropic",
            provider_model_id: "claude-haiku-4-5"
          }
        }),
        selectProviderWithCredential: async () => ({
          auth_method: "cli",
          provider_kind: "anthropic",
          encrypted_credential: null,
          base_url: null
        })
      } as never,
      {} as never,
      {
        createCliStructuredAdapter: () => ({
          generateStructured
        })
      }
    );

    await expect(deps.runChat("synthetic batch", undefined, 21)).resolves.toMatchObject({
      text: expect.any(String)
    });
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });
});
