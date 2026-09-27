import { describe, expect, it, afterEach, vi } from "vitest";

import { AiRepository, AiSecretCipher, HttpApiAdapter } from "@moss/ai";
import {
  applyGuidedPersonaText,
  createPersonaDraft,
  discardPersonaDraft,
  personaDraftIsDirty,
  personaSeedText
} from "../../apps/web/src/settings/settings-persona-preview.js";
import {
  createDefaultPersonaPreview,
  readPersonaPreviewResult
} from "../../packages/module-registry/src/built-in-module-helpers.js";
import type { DataContextDb, DataContextRunner } from "@moss/db";

const model = {
  provider_config_id: "provider-1",
  provider_kind: "anthropic",
  provider_model_id: "model-1"
} as const;

const input = {
  actorUserId: "user-1",
  assistantName: "Jarvis",
  personaText: "Be concise.",
  userName: "Ben"
};

function dataContext(): DataContextRunner {
  return {
    withDataContext: async (_context, callback) => callback({} as DataContextDb)
  } as DataContextRunner;
}

afterEach(() => vi.restoreAllMocks());

describe("personaSeedText", () => {
  it("turns dials into editable starter persona text", () => {
    expect(
      personaSeedText({
        tone: "Crisp",
        directness: "Direct",
        humor: "Dry",
        recovery: "Firm"
      })
    ).toContain("Keep responses crisp");
  });

  it("keeps authored text local until save and restores the server snapshot on discard", () => {
    const saved = { assistantName: "Jarvis", personaText: "Saved voice" };
    const draft = createPersonaDraft(saved);
    const guided = applyGuidedPersonaText(draft, {
      tone: "Crisp",
      directness: "Direct",
      humor: "Dry",
      recovery: "Firm"
    });

    expect(saved.personaText).toBe("Saved voice");
    expect(guided.personaText).toContain("Keep responses crisp");
    expect(personaDraftIsDirty(guided, saved)).toBe(true);
    const expected = { ...guided, ...saved };
    expect(discardPersonaDraft(saved, guided)).toEqual(expected);
  });

  it("extracts only text from the one-shot structured preview result", () => {
    expect(readPersonaPreviewResult({ rawObject: { text: "Keep it short." } })).toBe(
      "Keep it short."
    );
    expect(readPersonaPreviewResult({ rawText: '{"text":"Be direct."}' })).toBe("Be direct.");
    expect(() => readPersonaPreviewResult({ rawObject: { secret: "never show" } })).toThrow();
  });
});

describe("createDefaultPersonaPreview", () => {
  it("uses the effective per-user chat model and CLI transport without an API credential", async () => {
    const selectChatModelForUser = vi
      .spyOn(AiRepository.prototype, "selectChatModelForUser")
      .mockResolvedValue(model as never);
    const selectModelForCapability = vi.spyOn(AiRepository.prototype, "selectModelForCapability");
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      auth_method: "cli",
      provider_kind: "anthropic",
      acp_agent_id: "claude-acp",
      provider_model_id: "model-1"
    } as never);
    const generateStructured = vi.fn().mockResolvedValue({ rawObject: { text: "CLI reply" } });

    const preview = createDefaultPersonaPreview(dataContext(), {
      createCliStructuredAdapter: vi.fn(() => ({ generateStructured }) as never)
    });

    await expect(preview(input)).resolves.toBe("CLI reply");
    expect(selectChatModelForUser).toHaveBeenCalledOnce();
    expect(selectModelForCapability).not.toHaveBeenCalled();
    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { provider_kind: model.provider_kind, provider_model_id: model.provider_model_id },
        acpAgentId: "claude-acp",
        messages: expect.any(Array)
      })
    );
  });

  it("reports no effective model without touching provider credentials", async () => {
    vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(null);
    const selectProvider = vi.spyOn(AiRepository.prototype, "selectProviderWithCredential");

    const preview = createDefaultPersonaPreview(dataContext());

    await expect(preview(input)).rejects.toThrow("No active chat-capable model is configured");
    expect(selectProvider).not.toHaveBeenCalled();
  });

  it("reports missing CLI transport instead of asking for an API key", async () => {
    vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      auth_method: "cli",
      provider_kind: "anthropic",
      acp_agent_id: "claude-acp"
    } as never);

    const preview = createDefaultPersonaPreview(dataContext());

    await expect(preview(input)).rejects.toThrow("CLI preview transport is unavailable");
  });

  it("refuses a CLI provider without an ACP identity before choosing a transport", async () => {
    vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      auth_method: "cli",
      provider_kind: "openai-compatible",
      acp_agent_id: null
    } as never);
    const createCliStructuredAdapter = vi.fn();
    const preview = createDefaultPersonaPreview(dataContext(), { createCliStructuredAdapter });

    await expect(preview(input)).rejects.toThrow("no ACP agent");
    expect(createCliStructuredAdapter).not.toHaveBeenCalled();
  });

  it("keeps API success and provider failures on the safe HTTP path", async () => {
    vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      auth_method: "api_key",
      encrypted_credential: { ciphertext: "sealed" },
      base_url: "https://provider.test"
    } as never);
    vi.spyOn(AiSecretCipher.prototype, "decryptJson").mockReturnValue({ apiKey: "secret-key" });
    const generateChat = vi
      .spyOn(HttpApiAdapter.prototype, "generateChat")
      .mockResolvedValue({ text: "API reply" });

    const preview = createDefaultPersonaPreview(dataContext());
    await expect(preview(input)).resolves.toBe("API reply");
    expect(generateChat).toHaveBeenCalledOnce();

    generateChat.mockRejectedValueOnce(new Error("provider secret-key failure"));
    try {
      await preview(input);
      throw new Error("expected preview to fail");
    } catch (error) {
      expect(error).toMatchObject({
        message: "The selected chat provider could not generate a preview response"
      });
      expect(error).not.toHaveProperty("message", expect.stringContaining("secret-key"));
    }
  });

  it("reports missing API credentials without decrypting or leaking secrets", async () => {
    vi.spyOn(AiRepository.prototype, "selectChatModelForUser").mockResolvedValue(model as never);
    vi.spyOn(AiRepository.prototype, "selectProviderWithCredential").mockResolvedValue({
      auth_method: "api_key",
      encrypted_credential: null
    } as never);
    const decrypt = vi.spyOn(AiSecretCipher.prototype, "decryptJson");

    const preview = createDefaultPersonaPreview(dataContext());

    await expect(preview(input)).rejects.toThrow("requires its API credential");
    expect(decrypt).not.toHaveBeenCalled();
  });
});
