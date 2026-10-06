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

const createAiModel = vi.fn(async (_input: unknown) => ({ model: { id: "m1" } }));

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
  createAiModel: (input: unknown) => createAiModel(input as never),
  refreshAiProviderModels: vi.fn(async () => ({ models: [] })),
  revokeAiProvider: vi.fn(),
  updateAiProvider: vi.fn(),
  updateAiModel: vi.fn(),
  setInstanceDefaultProvider: vi.fn(),
  testAiProvider: vi.fn(),
  putAdminChatModelOverrideEnabled: vi.fn(),
  putAiServiceBinding: vi.fn(),
  deleteAiServiceBinding: vi.fn(),
  getAdminRuntimeConfig: vi.fn(async () => ({ config: { value: "off", source: "default" } })),
  putAdminRuntimeConfig: vi.fn(),
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

describe("AiProvidersPane services group (#2594)", () => {
  it("shows the Classifier row under the per-job rows", async () => {
    const client = await import("../../apps/web/src/api/client.js");
    vi.mocked(client.listAiProviders).mockResolvedValueOnce({
      providers: [
        {
          id: "p1",
          providerKind: "openai-compatible",
          displayName: "Local box",
          authMethod: "api_key",
          executionMode: "interactive",
          status: "active",
          hasCredential: true,
          isInstanceDefault: true
        }
      ]
    } as never);
    const renderer = await renderPane();
    const text = JSON.stringify(renderer.toJSON());
    expect(text.indexOf("Email reading")).toBeGreaterThan(-1);
    expect(text.indexOf("Classifier")).toBeGreaterThan(text.indexOf("Email reading"));
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

// #2570: the Trail Marker focus judge is the Classifier (Ben, 2026-09-22), so there is no
// separate Trail Marker row. A System One model is offered only in the Classifier row. The
// Services group only renders once a provider exists, so each test seeds one.
describe("AiProvidersPane Trail Marker judge is the Classifier (#2570)", () => {
  const SORTING_LABEL = "Classifier model";

  function seedSystemOne(): void {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        {
          id: "prov1",
          providerKind: "system-one",
          displayName: "System One",
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
          providerKind: "system-one",
          providerDisplayName: "System One",
          providerModelId: "jev-latest",
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
    vi.mocked(apiClient.listAiServiceBindings).mockResolvedValue({ bindings: {} } as never);
    vi.mocked(apiClient.putAiServiceBinding).mockClear();
  });

  function selects(renderer: ReactTestRenderer, label: string) {
    return renderer.root.findAll(
      (node) => node.type === "select" && node.props["aria-label"] === label
    );
  }

  const optionTexts = (renderer: ReactTestRenderer, label: string) =>
    selects(renderer, label)[0]!
      .findAllByType("option")
      .map((option) => option.children.join(""));

  it("has no separate Trail Marker row, and the Classifier row owns the Trail Marker judge", async () => {
    seedSystemOne();
    const renderer = await renderPane();
    expect(selects(renderer, "Binding for Trail Marker focus judgment")).toHaveLength(0);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Classifier");
    await act(async () => {
      renderer.unmount();
    });
  });

  it("offers a System One model only in the Classifier row and never as the default provider (fails without the provider-kind filters)", async () => {
    seedSystemOne();
    const renderer = await renderPane();
    expect(optionTexts(renderer, SORTING_LABEL)).toContain("Jev");
    expect(optionTexts(renderer, "Binding for Email reading")).not.toContain("Jev");
    const setDefault = renderer.root
      .findAllByType("button")
      .filter((button) => button.children.includes("Set as default"));
    expect(setDefault).toHaveLength(0);
    await act(async () => {
      renderer.unmount();
    });
  });

  it("binds the sorting key when Jev is chosen", async () => {
    seedSystemOne();
    vi.mocked(apiClient.putAiServiceBinding).mockResolvedValue({} as never);
    const renderer = await renderPane();
    const [row] = selects(renderer, SORTING_LABEL);
    await act(async () => {
      (row!.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "model:model1" }
      });
    });
    await flush();
    expect(apiClient.putAiServiceBinding).toHaveBeenCalledWith("sorting", {
      binding: { kind: "model", modelId: "model1" }
    });
    await act(async () => {
      renderer.unmount();
    });
  });

  it("with Jev bound, says Trail Marker data goes to TypeSafe and never claims stories go to it", async () => {
    seedSystemOne();
    vi.mocked(apiClient.listAiServiceBindings).mockResolvedValue({
      bindings: { sorting: { kind: "model", modelId: "model1" } }
    } as never);
    const renderer = await renderPane();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Trail Marker's app and window titles go to TypeSafe.");
    expect(text).not.toContain("Story details, your saved story preferences");
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe("AiProvidersPane add provider examples (#2586)", () => {
  it("shows each provider its own example address and key, not another company's", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Jev (TypeSafe)");
    await flush();

    expect(renderer.root.findByProps({ "aria-label": "Base URL" }).props.placeholder).toBe(
      "https://api.typesafe.ai"
    );
    expect(renderer.root.findByProps({ "aria-label": "API key" }).props.placeholder).toBe(
      "apikey_…"
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

// #3057: the picker gains three decision-model presets. Adding Clef builds its address from an
// account id; the compatible preset never locks out; Jev still recognises existing installs.
describe("AiProvidersPane decision-model presets (#3057)", () => {
  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  const CLOUDFLARE_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai`;

  const systemOneProvider = (overrides: Record<string, unknown> = {}) => ({
    id: "p-dm",
    providerKind: "system-one",
    displayName: "Jev (TypeSafe)",
    authMethod: "api_key",
    executionMode: "interactive",
    status: "active",
    hasCredential: true,
    isInstanceDefault: false,
    baseUrl: null,
    ...overrides
  });

  function catalogButton(renderer: ReactTestRenderer, label: string) {
    const button = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes(label));
    if (!button) throw new Error(`catalog button "${label}" not found`);
    return button;
  }

  beforeEach(() => {
    createAiProvider.mockClear();
    createAiModel.mockClear();
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    vi.mocked(apiClient.listAiModels).mockResolvedValue({ models: [] } as never);
  });

  afterEach(() => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    vi.mocked(apiClient.listAiModels).mockResolvedValue({ models: [] } as never);
  });

  it("shows Account ID and token for Clef and submits the built address", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Clef (Cloudflare)");
    await flush();

    expect(renderer.root.findByProps({ "aria-label": "Account ID" })).toBeTruthy();
    expect(renderer.root.findByProps({ "aria-label": "API token" })).toBeTruthy();

    const account = renderer.root.findByProps({ "aria-label": "Account ID" });
    await act(async () => {
      account.props.onChange({ target: { value: ACCOUNT_ID } });
    });
    const token = renderer.root.findByProps({ "aria-label": "API token" });
    await act(async () => {
      token.props.onChange({ target: { value: "cf-token" } });
    });

    clickButtonByText(renderer, "Add");
    await flush();

    expect(createAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "system-one",
        displayName: "Clef (Cloudflare)",
        authMethod: "api_key",
        baseUrl: CLOUDFLARE_BASE_URL,
        credentialPayload: { apiKey: "cf-token" }
      })
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it("disables Add while the Clef account id is malformed", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Clef (Cloudflare)");
    await flush();

    const account = renderer.root.findByProps({ "aria-label": "Account ID" });
    await act(async () => {
      account.props.onChange({ target: { value: "not-a-real-id" } });
    });
    const token = renderer.root.findByProps({ "aria-label": "API token" });
    await act(async () => {
      token.props.onChange({ target: { value: "cf-token" } });
    });

    const add = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.includes("Add"));
    if (!add) throw new Error('"Add" button not found');
    expect(add.props.disabled).toBe(true);
    expect(createAiProvider).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps Any compatible service addable after a compatible provider exists", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        systemOneProvider({
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1"
        })
      ]
    } as never);
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();

    expect(catalogButton(renderer, "Any compatible service").props.disabled).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("marks Jev added for an existing TypeSafe provider with no address", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [systemOneProvider({ displayName: "System One (TypeSafe)", baseUrl: null })]
    } as never);
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();

    expect(catalogButton(renderer, "Jev (TypeSafe)").props.disabled).toBe(true);
    expect(catalogButton(renderer, "Clef (Cloudflare)").props.disabled).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("pins the OpenRouter example address and names a compatible service by its host", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();
    clickButtonByText(renderer, "Any compatible service");
    await flush();

    const address = renderer.root.findByProps({ "aria-label": "Address" });
    expect(address.props.placeholder).toBe("https://openrouter.ai/api");
    await act(async () => {
      address.props.onChange({ target: { value: "https://openrouter.ai/api" } });
    });
    const key = renderer.root.findByProps({ "aria-label": "API key" });
    await act(async () => {
      key.props.onChange({ target: { value: "sk-or" } });
    });

    clickButtonByText(renderer, "Add");
    await flush();

    expect(createAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "system-one",
        displayName: "Decision model (openrouter.ai)",
        baseUrl: "https://openrouter.ai/api",
        credentialPayload: { apiKey: "sk-or" }
      })
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it("defaults a hand-added model on a decision model to json / economy", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [systemOneProvider()]
    } as never);
    vi.mocked(apiClient.listAiModels).mockResolvedValue({
      models: [
        {
          id: "model1",
          providerConfigId: "p-dm",
          providerKind: "system-one",
          providerDisplayName: "Jev (TypeSafe)",
          providerModelId: "jev-latest",
          displayName: "Jev",
          status: "active",
          providerStatus: "active",
          capabilities: ["json"],
          tier: "economy"
        }
      ]
    } as never);
    const renderer = await renderPane();

    const modelsToggle = renderer.root
      .findAllByType("button")
      .find((instance) => instance.children.join("").includes("Models · 1"));
    if (!modelsToggle) throw new Error("models toggle not found");
    act(() => {
      (modelsToggle.props.onClick as () => void)();
    });
    await flush();
    clickButtonByText(renderer, "Add model");
    await flush();

    const idInput = renderer.root.findByProps({ "aria-label": "Model id" });
    await act(async () => {
      idInput.props.onChange({ target: { value: "clef" } });
    });
    const nameInput = renderer.root.findByProps({ "aria-label": "Display name" });
    await act(async () => {
      nameInput.props.onChange({ target: { value: "Clef" } });
    });

    const form = renderer.root
      .findAllByType("form")
      .find((candidate) => String(candidate.props.className ?? "").includes("ai-model-form"));
    if (!form) throw new Error("add-model form not found");
    await act(async () => {
      form.props.onSubmit({ preventDefault: () => {} });
    });
    await flush();

    expect(createAiModel).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigId: "p-dm",
        providerModelId: "clef",
        displayName: "Clef",
        tier: "economy",
        capabilities: ["json"]
      })
    );

    await act(async () => {
      renderer.unmount();
    });
  });
});
