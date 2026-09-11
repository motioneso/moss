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
vi.mock("../../apps/web/src/api/onboarding-connect-client.js", () => ({
  checkOnboardingProvider: vi.fn(async () => ({ status: "ready" }))
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
  onModelOverride = vi.fn(),
  providerOverride: AiProviderConfigDto = provider
): Promise<{ renderer: ReactTestRenderer; onModelOverride: ReturnType<typeof vi.fn> }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ProviderModels, {
          provider: providerOverride,
          models,
          modelChoiceNote:
            providerOverride.providerKind === "google"
              ? "Chat uses this provider's login default because its ACP adapter does not expose model choice yet."
              : undefined,
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
  it("does not infer ACP login state from the model-list refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clientModule = await import("../../apps/web/src/api/client.js");
    vi.mocked(clientModule.refreshAiProviderModels).mockResolvedValueOnce({
      models: [],
      reason: "not_logged_in"
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ProviderModels, {
            provider: { ...provider, authMethod: "cli" } as AiProviderConfigDto,
            models: [],
            onModelOverride: vi.fn(),
            onModelStatusChange: vi.fn(),
            onModelDelete: vi.fn()
          })
        )
      );
    });
    expect(renderer.root.findAll((node) => node.props?.role === "status")).toHaveLength(0);
    expect(clientModule.refreshAiProviderModels).not.toHaveBeenCalled();
    const onboardingClient = await import("../../apps/web/src/api/onboarding-connect-client.js");
    expect(onboardingClient.checkOnboardingProvider).toHaveBeenCalledWith("openai-compatible");
  });

  it("shows ACP initialization refusal as not logged in", async () => {
    const onboardingClient = await import("../../apps/web/src/api/onboarding-connect-client.js");
    vi.mocked(onboardingClient.checkOnboardingProvider).mockResolvedValueOnce({
      status: "needs_login"
    });
    const { renderer } = await render([], vi.fn(), {
      ...provider,
      authMethod: "cli"
    } as AiProviderConfigDto);
    expect(
      renderer.root
        .findAllByProps({ role: "status" })
        .map((node) => node.children.join(" "))
        .some((text) => text === "Not logged in")
    ).toBe(true);
  });

  it("keeps ACP login refusal visible after model refresh succeeds", async () => {
    const onboardingClient = await import("../../apps/web/src/api/onboarding-connect-client.js");
    const clientModule = await import("../../apps/web/src/api/client.js");
    vi.mocked(onboardingClient.checkOnboardingProvider).mockResolvedValueOnce({
      status: "needs_login"
    });
    vi.mocked(clientModule.refreshAiProviderModels).mockResolvedValueOnce({ models: [] });
    const { renderer } = await render([], vi.fn(), {
      ...provider,
      authMethod: "cli"
    } as AiProviderConfigDto);

    const refresh = renderer.root
      .findAllByType("button")
      .find((button) => String(button.props.children).includes("Refresh models"));
    if (!refresh) throw new Error("Refresh models button not found");
    await act(async () => {
      (refresh.props.onClick as () => void)();
    });

    expect(
      renderer.root
        .findAllByProps({ role: "status" })
        .map((node) => node.children.join(" "))
        .some((text) => text === "Not logged in")
    ).toBe(true);
  });

  it("shows when the ACP provider keeps the login's model default", async () => {
    const { renderer } = await render([], vi.fn(), {
      ...provider,
      providerKind: "google"
    } as AiProviderConfigDto);
    expect(renderer.root.findByProps({ role: "note" }).children.join(" ")).toContain(
      "login default"
    );
  });

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
