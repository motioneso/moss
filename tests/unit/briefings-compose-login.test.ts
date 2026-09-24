import { describe, expect, it } from "vitest";

import { composeBriefing, type ComposeDeps } from "../../packages/briefings/src/compose.js";
import { definition, fakeScopedDb, makeFakeDeps, runInput } from "./briefings-compose.harness.js";

describe("composeBriefing — subscription-login providers", () => {
  function withLoginProvider(deps: ComposeDeps): ComposeDeps {
    const aiRepository = Object.create(deps.aiRepository) as ComposeDeps["aiRepository"];
    aiRepository.selectProviderWithCredential = async () =>
      ({
        id: "pc-1",
        base_url: null,
        auth_method: "cli",
        encrypted_credential: { v: 1 }
      }) as unknown as Awaited<
        ReturnType<ComposeDeps["aiRepository"]["selectProviderWithCredential"]>
      >;
    return {
      ...deps,
      aiRepository,
      cipher: {
        decryptJson: () => {
          throw new Error("a login provider must never be decrypted");
        }
      } as unknown as ComposeDeps["cipher"]
    };
  }

  it("writes the briefing through the CLI transport", async () => {
    let prompt = "";
    const deps: ComposeDeps = {
      ...withLoginProvider(makeFakeDeps()),
      createCliStructuredAdapter: () => ({
        generateStructured: async (input) => {
          prompt = input.messages.map((turn) => turn.content).join("\n");
          return {
            rawObject: { text: "login narrative" },
            usage: { inputTokens: 0, outputTokens: 0 }
          };
        }
      })
    };
    const result = await composeBriefing(fakeScopedDb, definition(), runInput, deps);
    expect(result.sourceMetadata.degraded).not.toBe(true);
    expect(result.summaryText).toBe("login narrative");
    expect(result.sourceMetadata.aiModel).toMatchObject({ id: "model-1" });
    expect(prompt).toContain("<trusted_instructions>");
  });

  it("falls back with credential_error when no CLI transport is wired", async () => {
    const result = await composeBriefing(
      fakeScopedDb,
      definition(),
      runInput,
      withLoginProvider(makeFakeDeps())
    );
    expect(result.sourceMetadata.degraded).toBe(true);
    expect(result.sourceMetadata.degradedReason).toBe("credential_error");
  });
});
