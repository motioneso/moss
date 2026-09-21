// @vitest-environment jsdom
// Regression coverage for #1325: adding an api_key-auth provider from the picker sent no
// credentialPayload, so the server's fail-closed guard (packages/ai/src/routes.ts:759) 400'd
// every attempt. The picker must collect the credential before calling createAiProvider — same
// jsdom + react-test-renderer + vi.mock(client.js) pattern established in
// tests/unit/settings-ai-pane.test.tsx (this repo has no @testing-library/react).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const createAiProvider = vi.fn(async (_input: unknown) => ({
  provider: {
    id: "p1",
    providerKind: "openai-compatible",
    displayName: "Mistral",
    authMethod: "api_key",
    executionMode: "interactive",
    status: "active",
    hasCredential: true,
    isInstanceDefault: false
  }
}));

vi.mock("../../apps/web/src/api/client.js", () => ({
  getChatSettings: vi.fn(async () => ({ chat: { responseStyle: "balanced" } })),
  putChatSettings: vi.fn(),
  listAiProviders: vi.fn(async () => ({ providers: [] })),
  listAiModels: vi.fn(async () => ({ models: [] })),
  listAiServiceBindings: vi.fn(async () => ({ bindings: {} })),
  getChatModelOverrideSettings: vi.fn(async () => ({
    settings: {
      overrideEnabled: false,
      currentOverrideModelId: null,
      effectiveOverrideModelId: null,
      defaultModel: null,
      selectedModel: null,
      selectableOverrideModels: []
    }
  })),
  getPersonaSettings: vi.fn(async () => ({
    persona: { assistantName: "Moss", personaText: "" }
  })),
  createAiProvider: (input: unknown) => createAiProvider(input as never),
  revokeAiProvider: vi.fn(),
  updateAiProvider: vi.fn(),
  updateAiModel: vi.fn(),
  setInstanceDefaultProvider: vi.fn(),
  testAiProvider: vi.fn(),
  putAdminChatModelOverrideEnabled: vi.fn(),
  putAiServiceBinding: vi.fn(),
  lookupAiCapabilityRoute: vi.fn(async () => ({ route: null })),
  getVoiceEndpoint: vi.fn(async () => ({ endpoint: null })),
  putVoiceEndpoint: vi.fn(),
  getMe: vi.fn(async () => ({
    user: { id: "u1", isInstanceAdmin: true, isBootstrapOwner: false },
    profilePrefs: { addressed: null },
    hasPasswordCredential: true
  })),
  getAdminYoloSettings: vi.fn(async () => ({
    instanceEnabled: false,
    self: { allowed: false, enabled: false, active: false }
  })),
  postAdminYoloAllowAll: vi.fn(),
  putAdminYoloInstance: vi.fn(),
  putAdminYoloUser: vi.fn(),
  deleteWebSearchKey: vi.fn(),
  getWebSearchKey: vi.fn(async () => ({ hasKey: false })),
  putWebSearchKey: vi.fn()
}));

vi.mock("../../apps/web/src/api/client-admin.js", () => ({
  getAdminUserAiPin: vi.fn(async () => ({ pin: null })),
  putAdminUserAiPin: vi.fn()
}));

import * as apiClient from "../../apps/web/src/api/client.js";
import { AiProvidersPane } from "../../apps/web/src/settings/settings-ai-admin-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPane(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FeedbackProvider, null, createElement(AiProvidersPane))
      )
    );
  });
  await flush();
  return renderer;
}

function clickButtonByText(renderer: ReactTestRenderer, text: string): void {
  const button = renderer.root
    .findAllByType("button")
    .find((instance) => instance.children.includes(text));
  if (!button) throw new Error(`button "${text}" not found`);
  act(() => {
    (button.props.onClick as () => void)();
  });
}

describe("AiProvidersPane provider picker (#1325)", () => {
  beforeEach(() => {
    createAiProvider.mockClear();
  });

  it("opens a credential form for an api_key catalog entry instead of creating immediately", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();

    clickButtonByText(renderer, "Mistral");
    await flush();

    expect(createAiProvider).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ "aria-label": "API key" })).toBeTruthy();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("disables Add while the API key field is empty", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Mistral");
    await flush();

    const addButton = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Add"));
    if (!addButton) throw new Error('"Add" button not found');
    expect(addButton.props.disabled).toBe(true);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("sends credentialPayload.apiKey when creating an api_key provider", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Mistral");
    await flush();

    const apiKeyInput = renderer.root.findByProps({ "aria-label": "API key" });
    await act(async () => {
      apiKeyInput.props.onChange({ target: { value: "sk-test-123" } });
    });

    clickButtonByText(renderer, "Add");
    await flush();

    expect(createAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "openai-compatible",
        displayName: "Mistral",
        authMethod: "api_key",
        credentialPayload: { apiKey: "sk-test-123" }
      })
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it("still creates a cli catalog entry immediately, with no credentialPayload key at all", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();

    clickButtonByText(renderer, "Anthropic");
    await flush();

    expect(createAiProvider).toHaveBeenCalledTimes(1);
    const sent = createAiProvider.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(sent.providerKind).toBe("anthropic");
    expect(sent.authMethod).toBe("cli");
    expect("credentialPayload" in sent).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("AiProvidersPane", () => {
  it("has no Embeddings group, provider/model controls, or stub copy (#1182)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FeedbackProvider, null, createElement(AiProvidersPane))
      )
    );

    expect(html).not.toContain("Embeddings");
    expect(html).not.toContain("stub");
    expect(html).not.toContain('aria-label="Embedding provider"');
    expect(html).not.toContain('aria-label="Embedding model"');
    expect(html).not.toContain("Embedding provider saved");
    expect(html).not.toContain("Embedding model saved");
  });
});

// #2570: the Trail Marker focus judgment gets its own row. It starts empty, offers specific models
// only (no Mode option that would borrow the default provider's model), and is admin-set. The
// Services group only renders once a provider exists, so each test seeds one.
describe("AiProvidersPane Trail Marker focus judgment row (#2570)", () => {
  const ROW_LABEL = "Binding for Trail Marker focus judgment";

  function seedProviderAndModel(): void {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        {
          id: "prov1",
          providerKind: "openai-compatible",
          displayName: "Hosted",
          authMethod: "api_key",
          executionMode: "interactive",
          status: "active",
          hasCredential: true,
          isInstanceDefault: false
        }
      ]
    } as never);
    vi.mocked(apiClient.listAiModels).mockResolvedValue({
      models: [
        {
          id: "model1",
          providerConfigId: "prov1",
          providerModelId: "jev-1",
          displayName: "Jev",
          status: "active",
          providerStatus: "active",
          capabilities: ["json"],
          tier: "economy"
        }
      ]
    } as never);
  }

  afterEach(() => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    vi.mocked(apiClient.listAiModels).mockResolvedValue({ models: [] } as never);
    vi.mocked(apiClient.putAiServiceBinding).mockClear();
  });

  function selects(renderer: ReactTestRenderer, label: string) {
    return renderer.root.findAll(
      (node) => node.type === "select" && node.props["aria-label"] === label
    );
  }

  it("lists the row, starts empty with 'Not set', and offers no Mode option (fails if a default is pre-filled)", async () => {
    seedProviderAndModel();
    const renderer = await renderPane();

    const [trailMarker] = selects(renderer, ROW_LABEL);
    expect(trailMarker).toBeTruthy();
    expect(trailMarker?.props.value).toBe("");

    const optionTexts = trailMarker!
      .findAllByType("option")
      .map((option) => option.children.join(""));
    expect(optionTexts).toContain("Not set: choose a model");
    expect(optionTexts).toContain("Jev");
    expect(trailMarker!.findAllByType("optgroup")).toHaveLength(1);
    expect(trailMarker!.findAllByType("optgroup")[0]?.props.label).toBe("Specific model");

    // The existing strict row still offers Mode, so the difference is specific to this row.
    const [emailExtraction] = selects(renderer, "Binding for Email extraction");
    const emailGroups = emailExtraction!
      .findAllByType("optgroup")
      .map((group) => group.props.label as string);
    expect(emailGroups).toContain("Mode (uses the default provider)");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("says only an admin can set it and that nothing runs until a model is chosen", async () => {
    seedProviderAndModel();
    const renderer = await renderPane();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Trail Marker focus judgment");
    expect(text).toContain("Only an admin can set it");
    expect(text).toContain("nothing is processed until you choose one");
    expect(text).toContain("command-line tool");
    await act(async () => {
      renderer.unmount();
    });
  });

  it("binds the platform key to the chosen model", async () => {
    seedProviderAndModel();
    vi.mocked(apiClient.putAiServiceBinding).mockResolvedValue({} as never);

    const renderer = await renderPane();
    const [row] = selects(renderer, ROW_LABEL);
    await act(async () => {
      (row!.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "model:model1" }
      });
    });
    await flush();

    expect(apiClient.putAiServiceBinding).toHaveBeenCalledWith("module.trail-marker.judge", {
      binding: { kind: "model", modelId: "model1" }
    });

    await act(async () => {
      renderer.unmount();
    });
  });
  it("shows each provider its own example address and key, not another company's", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "System One (TypeSafe)");
    await flush();

    expect(renderer.root.findByProps({ "aria-label": "Base URL" }).props.placeholder).toBe(
      "https://api.typesafe.ai"
    );
    expect(renderer.root.findByProps({ "aria-label": "API key" }).props.placeholder).toBe(
      "Your TypeSafe API key"
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not show Anthropic's address or an sk- key style to a Mistral (OpenAI-compatible) provider", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Mistral");
    await flush();

    const base = renderer.root.findByProps({ "aria-label": "Base URL" }).props.placeholder;
    expect(base).not.toContain("anthropic");
    expect(base).toBe("https://api.openai.com");

    await act(async () => {
      renderer.unmount();
    });
  });
});
