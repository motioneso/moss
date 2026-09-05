// @vitest-environment jsdom
// Ben, 2026-09-04 (Assistant & AI notes): the per-model "available for user chat override"
// switch is gone; the Chat tag on the row is the toggle, and it dims when chat is off.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/web/src/api/client.js", () => ({
  refreshAiProviderModels: vi.fn(async () => ({ models: [] })),
  createAiModel: vi.fn(),
  updateAiModel: vi.fn()
}));

import { ProviderModels } from "../../apps/web/src/settings/settings-ai-provider-models.js";
import type { AiConfiguredModelDto, AiProviderConfigDto } from "@moss/shared";

const provider = {
  id: "p1",
  providerKind: "openai-compatible",
  displayName: "Mistral",
  authMethod: "api_key",
  executionMode: "interactive",
  status: "active",
  hasCredential: true,
  isInstanceDefault: false
} as unknown as AiProviderConfigDto;

function model(overrides: Partial<AiConfiguredModelDto>): AiConfiguredModelDto {
  return {
    id: "m1",
    providerConfigId: "p1",
    providerModelId: "mistral-large",
    displayName: "Mistral Large",
    capabilities: ["chat", "tool-use"],
    status: "active",
    tier: "interactive",
    allowUserOverride: true,
    origin: "discovered",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...overrides
  } as AiConfiguredModelDto;
}

async function render(
  models: readonly AiConfiguredModelDto[],
  onModelOverride = vi.fn()
): Promise<{ renderer: ReactTestRenderer; onModelOverride: ReturnType<typeof vi.fn> }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProviderModels, {
          provider,
          models,
          onModelOverride,
          onModelStatusChange: vi.fn(),
          onModelDelete: vi.fn()
        })
      )
    );
  });
  // The list is collapsed by default; open it from its header.
  const header = renderer.root
    .findAllByType("button")
    .find((b) => b.props["aria-expanded"] !== undefined);
  if (!header) throw new Error("Models header not found");
  await act(async () => {
    (header.props.onClick as () => void)();
  });
  return { renderer, onModelOverride };
}

function chatTag(renderer: ReactTestRenderer) {
  const tag = renderer.root
    .findAllByType("button")
    .find((b) => String(b.props.className ?? "").includes("cap--toggle"));
  if (!tag) throw new Error("Chat tag not found");
  return tag;
}

describe("ProviderModels chat tag", () => {
  it("renders the Chat tag as a pressed toggle and no separate switch", async () => {
    const { renderer } = await render([model({})]);
    const tag = chatTag(renderer);
    expect(tag.props["aria-pressed"]).toBe(true);
    expect(String(tag.props.className)).not.toContain("cap--off");
    expect(renderer.root.findAll((n) => n.props?.role === "switch")).toHaveLength(0);
  });

  it("dims the tag when chat is off and toggles on click", async () => {
    const { renderer, onModelOverride } = await render([model({ allowUserOverride: false })]);
    const tag = chatTag(renderer);
    expect(tag.props["aria-pressed"]).toBe(false);
    expect(String(tag.props.className)).toContain("cap--off");
    act(() => {
      (tag.props.onClick as () => void)();
    });
    expect(onModelOverride).toHaveBeenCalledTimes(1);
    expect(onModelOverride.mock.calls[0]?.[0]?.id).toBe("m1");
    expect(onModelOverride.mock.calls[0]?.[1]).toBe(true);
  });

  it("shows no toggle on a model without the chat capability", async () => {
    const { renderer } = await render([model({ capabilities: ["vision"] })]);
    const toggles = renderer.root
      .findAllByType("button")
      .filter((b) => String(b.props.className ?? "").includes("cap--toggle"));
    expect(toggles).toHaveLength(0);
  });
});
