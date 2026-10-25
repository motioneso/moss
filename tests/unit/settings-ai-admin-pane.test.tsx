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
import { ChatControlsProvider } from "../../apps/web/src/shell/chat-controls-context.js";

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
  getAiProviderChatReadiness: vi.fn(async () => ({ status: "ready" })),
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

const chatControls = {
  openChat: () => {},
  openChatThread: () => {},
  openChatWith: () => {},
  openAssistantWithDraft: vi.fn()
};

async function renderPane(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ChatControlsProvider,
          { value: chatControls },
          createElement(FeedbackProvider, null, createElement(AiProvidersPane))
        )
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

function radioFor(renderer: ReactTestRenderer, id: string) {
  const radio = renderer.root.findAll(
    (node) => node.type === "input" && node.props.type === "radio" && node.props.value === id
  )[0];
  if (!radio) throw new Error(`choice "${id}" not found`);
  return radio;
}

/** Opens the Add provider dialog and walks Choose then Connect for one catalog choice. */
async function openConnect(renderer: ReactTestRenderer, id: string): Promise<void> {
  clickButtonByText(renderer, "Add provider");
  await flush();
  await act(async () => {
    (radioFor(renderer, id).props.onChange as () => void)();
  });
  clickButtonByText(renderer, "Next");
  await flush();
}

async function fill(renderer: ReactTestRenderer, label: string, value: string): Promise<void> {
  const input = renderer.root.findByProps({ "aria-label": label });
  await act(async () => {
    input.props.onChange({ target: { value } });
  });
}

function addButton(renderer: ReactTestRenderer) {
  const button = renderer.root
    .findAllByType("button")
    .find((instance) => instance.children.includes("Add"));
  if (!button) throw new Error('"Add" button not found');
  return button;
}

const unmount = (renderer: ReactTestRenderer) =>
  act(async () => {
    renderer.unmount();
  });

describe("AiProvidersPane Add provider dialog", () => {
  beforeEach(() => {
    createAiProvider.mockClear();
  });

  it("opens a dialog with every choice grouped by how it connects", async () => {
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();

    expect(renderer.root.findAllByProps({ role: "dialog" }).length).toBeGreaterThan(0);
    const text = JSON.stringify(renderer.toJSON());
    for (const group of ["Sign in with a subscription", "Use an API key", "Decision models"]) {
      expect(text).toContain(group);
    }
    for (const id of ["claude", "codex", "gemini", "opencode", "openai-compatible", "anthropic"]) {
      expect(radioFor(renderer, id)).toBeTruthy();
    }
    // The old picker choices are gone.
    for (const id of ["mistral", "custom"]) {
      expect(
        renderer.root.findAll(
          (node) => node.type === "input" && node.props.type === "radio" && node.props.value === id
        )
      ).toHaveLength(0);
    }

    await unmount(renderer);
  });

  it("asks for the credential on the Connect step instead of creating immediately", async () => {
    const renderer = await renderPane();
    await openConnect(renderer, "openai-compatible");

    expect(createAiProvider).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ "aria-label": "API key" })).toBeTruthy();
    expect(addButton(renderer).props.disabled).toBe(true);

    await unmount(renderer);
  });

  it("prefills the name and sends the typed name with the API key", async () => {
    const renderer = await renderPane();
    await openConnect(renderer, "openai-compatible");

    expect(renderer.root.findByProps({ "aria-label": "Name" }).props.value).toBe(
      "OpenAI-compatible"
    );
    await fill(renderer, "Name", "Work Mistral");
    await fill(renderer, "API key", "sk-test-123");
    clickButtonByText(renderer, "Add");
    await flush();

    expect(createAiProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "openai-compatible",
        displayName: "Work Mistral",
        authMethod: "api_key",
        credentialPayload: { apiKey: "sk-test-123" }
      })
    );

    await unmount(renderer);
  });

  it("prefills the next free name when the same choice already exists", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        {
          id: "p1",
          providerKind: "openai-compatible",
          displayName: "OpenAI-compatible",
          authMethod: "api_key",
          executionMode: "interactive",
          status: "active",
          hasCredential: true,
          isInstanceDefault: false
        }
      ]
    } as never);
    const renderer = await renderPane();
    await openConnect(renderer, "openai-compatible");

    expect(renderer.root.findByProps({ "aria-label": "Name" }).props.value).toBe(
      "OpenAI-compatible 2"
    );
    clickButtonByText(renderer, "Back");
    await flush();
    expect(radioFor(renderer, "openai-compatible").props.disabled).toBeFalsy();

    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    await unmount(renderer);
  });

  it("creates a subscription choice with no credentialPayload key at all", async () => {
    const renderer = await renderPane();
    await openConnect(renderer, "claude");

    expect(renderer.root.findAllByProps({ "aria-label": "API key" })).toHaveLength(0);
    clickButtonByText(renderer, "Add and sign in");
    await flush();

    expect(createAiProvider).toHaveBeenCalledTimes(1);
    const sent = createAiProvider.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(sent.providerKind).toBe("anthropic");
    expect(sent.authMethod).toBe("cli");
    expect(sent.displayName).toBe("Claude");
    expect("credentialPayload" in sent).toBe(false);

    await unmount(renderer);
  });

  it("disables a subscription choice that already has a provider, with the plain reason", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        {
          id: "p1",
          providerKind: "anthropic",
          displayName: "Claude",
          authMethod: "cli",
          executionMode: "interactive",
          status: "active",
          hasCredential: false,
          isInstanceDefault: false,
          cliAvailable: true
        }
      ]
    } as never);
    const renderer = await renderPane();
    clickButtonByText(renderer, "Add provider");
    await flush();

    expect(radioFor(renderer, "claude").props.disabled).toBe(true);
    expect(radioFor(renderer, "codex").props.disabled).toBeFalsy();
    expect(radioFor(renderer, "anthropic").props.disabled).toBeFalsy();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Already connected. Remove it to sign in with another account."
    );

    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    await unmount(renderer);
  });

  it("Back returns to Choose and keeps the chosen group selected", async () => {
    const renderer = await renderPane();
    await openConnect(renderer, "anthropic");
    clickButtonByText(renderer, "Back");
    await flush();

    expect(radioFor(renderer, "anthropic").props.checked).toBe(true);

    await unmount(renderer);
  });

  it("renders no Authentication switch or CLI agent dropdown on a provider card", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        {
          id: "p1",
          providerKind: "openai-compatible",
          displayName: "Codex",
          authMethod: "cli",
          acpAgentId: "codex-acp",
          executionMode: "interactive",
          status: "active",
          hasCredential: false,
          isInstanceDefault: false,
          cliAvailable: true
        }
      ]
    } as never);
    const renderer = await renderPane();
    clickButtonByText(renderer, "Edit");
    await flush();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("Authentication");
    expect(text).not.toContain("CLI agent");

    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    await unmount(renderer);
  });

  it("still renders and edits a pre-existing Custom provider", async () => {
    vi.mocked(apiClient.listAiProviders).mockResolvedValue({
      providers: [
        {
          id: "p-custom",
          providerKind: "custom",
          displayName: "My custom host",
          authMethod: "api_key",
          executionMode: "interactive",
          status: "active",
          hasCredential: true,
          isInstanceDefault: false
        }
      ]
    } as never);
    vi.mocked(apiClient.updateAiProvider).mockClear();
    const renderer = await renderPane();
    expect(JSON.stringify(renderer.toJSON())).toContain("My custom host");

    clickButtonByText(renderer, "Edit");
    await flush();
    expect(renderer.root.findByProps({ "aria-label": "Base URL" })).toBeTruthy();
    await fill(renderer, "API key", "sk-custom-new");
    clickButtonByText(renderer, "Save");
    await flush();

    expect(apiClient.updateAiProvider).toHaveBeenCalledWith(
      "p-custom",
      expect.objectContaining({ credentialPayload: { apiKey: "sk-custom-new" } })
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("Authentication");
    expect(text).not.toContain("CLI agent");

    vi.mocked(apiClient.listAiProviders).mockResolvedValue({ providers: [] } as never);
    await unmount(renderer);
  });

  it("shows one section for which model does what, with the override switch inside it", async () => {
    const renderer = await renderPane();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Which model does what");
    expect(text).not.toContain("User chat override");
    expect(text).not.toContain("Chat lock (this account)");
    await unmount(renderer);
  });
});

describe("AiProvidersPane services group (#2594)", () => {
  it("shows the Decision model row under the per-job rows", async () => {
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
    expect(text.indexOf("Decision model")).toBeGreaterThan(text.indexOf("Email reading"));
  });
});

describe("AiProvidersPane", () => {
  it("has no Embeddings group, provider/model controls, or stub copy (#1182)", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          ChatControlsProvider,
          { value: chatControls },
          createElement(FeedbackProvider, null, createElement(AiProvidersPane))
        )
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
    expect(text).toContain("Decision model");
    await act(async () => {
      renderer.unmount();
    });
  });

  it("offers a System One model only in the Classifier row and never as the default provider (fails without the provider-kind filters)", async () => {
    seedSystemOne();
    const renderer = await renderPane();
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Choose a model")!
        .props.onClick();
    });
    const dialogText = JSON.stringify(renderer.toJSON());
    expect(dialogText).toContain("Choose a decision model");
    expect(dialogText).toContain("Jev");
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
    const press = async (label: string) =>
      act(async () => {
        renderer.root
          .findAllByType("button")
          .find((button) => button.children.join("") === label)!
          .props.onClick();
      });
    await press("Choose a model");
    await act(async () => {
      renderer.root
        .findAll((node) => node.type === "input" && node.props.type === "radio")[0]!
        .props.onChange();
    });
    await press("Save");
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
    await openConnect(renderer, "anthropic");

    expect(renderer.root.findByProps({ "aria-label": "Base URL" }).props.placeholder).toBe(
      "https://api.anthropic.com"
    );
    expect(renderer.root.findByProps({ "aria-label": "API key" }).props.placeholder).toBe(
      "sk-ant-…"
    );

    await unmount(renderer);
  });

  it("does not show Anthropic's address or an sk- key style to an OpenAI-compatible provider", async () => {
    const renderer = await renderPane();
    await openConnect(renderer, "openai-compatible");

    const base = renderer.root.findByProps({ "aria-label": "Base URL" }).props.placeholder;
    expect(base).not.toContain("anthropic");
    expect(base).toBe("https://api.openai.com");

    await unmount(renderer);
  });
});

// #3057: the dialog offers three decision-model presets. Adding Clef builds its address from an
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
    await openConnect(renderer, "clef");

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
        displayName: "Clef",
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
    await openConnect(renderer, "clef");

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

    expect(radioFor(renderer, "compatible").props.disabled).toBeFalsy();
    expect(radioFor(renderer, "jev").props.disabled).toBeFalsy();

    await unmount(renderer);
  });

  it("pins the OpenRouter example address and sends the typed name", async () => {
    const renderer = await renderPane();
    await openConnect(renderer, "compatible");

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
        displayName: "Any compatible service",
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
