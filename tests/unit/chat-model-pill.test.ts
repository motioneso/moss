import { describe, expect, it } from "vitest";

import { activeChatModel, buildChatModelChoices } from "../../apps/web/src/chat/chat-model-pill.js";
import type { AiConfiguredModelDto, ChatModelOverrideSettingsDto } from "@moss/shared";

function model(overrides: Partial<AiConfiguredModelDto>): AiConfiguredModelDto {
  return {
    id: "m-default",
    providerConfigId: "provider-a",
    providerKind: "anthropic",
    providerDisplayName: "Anthropic",
    providerStatus: "active",
    providerModelId: "claude",
    displayName: "Claude",
    capabilities: ["chat"],
    status: "active",
    tier: "interactive",
    allowUserOverride: true,
    origin: "discovered",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides
  };
}

function settings(overrides: Partial<ChatModelOverrideSettingsDto>): ChatModelOverrideSettingsDto {
  const defaultModel = model({});
  return {
    overrideEnabled: true,
    currentOverrideModelId: null,
    effectiveOverrideModelId: null,
    defaultModel,
    selectedModel: null,
    selectableOverrideModels: [],
    ...overrides
  };
}

describe("chat model pill model choices", () => {
  it("uses instance default as active model when no override is effective", () => {
    const defaultModel = model({ id: "default", providerModelId: "default-model" });
    const result = activeChatModel(settings({ defaultModel }));

    expect(result?.id).toBe("default");
  });

  it("classifies same-provider and cross-provider choices from existing provider ids", () => {
    const selected = model({ id: "sonnet", providerConfigId: "provider-a" });
    const otherProvider = model({
      id: "gpt",
      providerConfigId: "provider-b",
      providerKind: "openai-compatible",
      providerDisplayName: "OpenAI"
    });

    const choices = buildChatModelChoices(
      settings({
        currentOverrideModelId: "sonnet",
        effectiveOverrideModelId: "sonnet",
        selectedModel: selected,
        selectableOverrideModels: [selected, otherProvider]
      })
    );

    expect(choices.find((choice) => choice.modelId === "sonnet")?.relation).toBe("same-provider");
    expect(choices.find((choice) => choice.modelId === "gpt")?.relation).toBe("cross-provider");
  });
});
