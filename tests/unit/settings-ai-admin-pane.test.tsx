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
import { describe, expect, it, vi, beforeEach } from "vitest";

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
