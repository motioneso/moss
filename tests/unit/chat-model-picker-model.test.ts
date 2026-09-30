import { describe, expect, it } from "vitest";

import {
  favoriteChoices,
  filterChoices,
  groupChoicesByProvider,
  toggleFavoriteIds,
  type ModelChoice
} from "../../apps/web/src/chat/chat-model-picker-model.js";
import { normalizeChatModelFavorites } from "../../packages/ai/src/chat-model-override.js";
import type { AiConfiguredModelDto } from "@moss/shared";

function choice(
  modelId: string | null,
  provider: { id: string; name: string },
  selected = false
): ModelChoice {
  const model = {
    id: modelId ?? "default",
    providerConfigId: provider.id,
    providerDisplayName: provider.name,
    providerModelId: modelId ?? "default-model",
    displayName: modelId ?? "Instance default"
  } as AiConfiguredModelDto;
  return {
    modelId,
    model,
    label: modelId ?? "Instance default",
    providerLabel: provider.name,
    relation: "same-provider",
    selected
  };
}

const anthropic = { id: "p-anthropic", name: "Anthropic" };
const openai = { id: "p-openai", name: "OpenAI" };

const choices = [
  choice(null, anthropic),
  choice("claude-opus", anthropic),
  choice("gpt-sol", openai, true),
  choice("claude-sonnet", anthropic),
  choice("gpt-luna", openai)
];

describe("chat model picker grouping", () => {
  it("groups real models by provider in first-seen order and leaves out the default row", () => {
    const groups = groupChoicesByProvider(choices);

    expect(groups.map((group) => group.label)).toEqual(["Anthropic", "OpenAI"]);
    expect(groups[0]?.choices.map((c) => c.modelId)).toEqual(["claude-opus", "claude-sonnet"]);
    expect(groups[1]?.choices.map((c) => c.modelId)).toEqual(["gpt-sol", "gpt-luna"]);
  });

  it("marks the provider that holds the current model", () => {
    const groups = groupChoicesByProvider(choices);

    expect(groups[0]?.selectedChoice).toBeNull();
    expect(groups[1]?.selectedChoice?.modelId).toBe("gpt-sol");
  });
});

describe("chat model picker favorites", () => {
  it("lists starred models in star order and skips models no longer offered", () => {
    const result = favoriteChoices(choices, ["gpt-luna", "gone", "claude-opus"]);

    expect(result.map((c) => c.modelId)).toEqual(["gpt-luna", "claude-opus"]);
  });

  it("stars a model by appending it", () => {
    expect(toggleFavoriteIds(["a"], "b", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("unstars a model and drops stale ids in the same write", () => {
    expect(toggleFavoriteIds(["a", "stale", "b"], "a", ["a", "b"])).toEqual(["b"]);
  });
});

describe("chat model picker search", () => {
  it("matches model and provider names, case-insensitively, without the default row", () => {
    expect(filterChoices(choices, "OPENAI").map((c) => c.modelId)).toEqual(["gpt-sol", "gpt-luna"]);
    expect(filterChoices(choices, "sonnet").map((c) => c.modelId)).toEqual(["claude-sonnet"]);
  });
});

describe("stored favorites normalization", () => {
  it("keeps unique non-empty strings up to the cap", () => {
    expect(normalizeChatModelFavorites(["a", "a", "", 3, "b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("treats a non-array value as no favorites", () => {
    expect(normalizeChatModelFavorites({ a: 1 }, 10)).toEqual([]);
    expect(normalizeChatModelFavorites(undefined, 10)).toEqual([]);
  });
});
