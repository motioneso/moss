import type { Page, Route } from "@playwright/test";
import type {
  AiAssistantToolDto,
  AiConfiguredModelDto,
  AiModelCapability,
  AiProviderConfigDto,
  AiServiceBinding,
  AiServiceBindingMapDto,
  AiServiceKey,
  CreateAiConfiguredModelRequest,
  CreateAiProviderConfigRequest,
  PutAiServiceBindingRequest,
  UpdateAiConfiguredModelRequest,
  UpdateAiProviderConfigRequest
} from "@moss/shared";

// #870 Slice 1: the admin AI surface now models per-service bindings (Chat + Voice) instead of the
// old per-capability manual routes / tier preferences. A binding is either a "mode" (tier resolved
// inside the instance-default provider) or a specific model.
export interface MockAiApiState {
  aiServiceBindings?: AiServiceBindingMapDto;
  aiModels?: AiConfiguredModelDto[];
  aiProviders?: AiProviderConfigDto[];
}

export async function registerMockAiRoutes(page: Page, state: MockAiApiState): Promise<void> {
  const discoveredModels = [
    {
      providerModelId: "gpt-4o",
      displayName: "gpt-4o",
      capabilities: ["chat", "tool-use", "json", "summarization"],
      tier: "interactive",
      fromCache: false,
      fromFallback: false
    }
  ];
  await page.route(/\/api\/ai\/providers\/[^/]+\/test$/, (route) =>
    fulfillJson(route, 200, {
      result: {
        ok: true,
        providerKind: "openai-compatible",
        message: "Provider credential is valid."
      }
    })
  );
  await page.route(/\/api\/ai\/providers\/[^/]+\/models\/discover$/, (route) =>
    fulfillJson(route, 200, {
      models: discoveredModels,
      fromFallback: false,
      cacheExpiresAt: null
    })
  );
  await page.route(/\/api\/ai\/providers\/[^/]+\/discover-models$/, (route) =>
    fulfillJson(route, 200, {
      models: discoveredModels.map(
        ({ fromCache: _fromCache, fromFallback: _fromFallback, ...model }) => model
      )
    })
  );
  await page.route(/\/api\/ai\/providers\/[^/]+\/revoke$/, (route) =>
    handleAiProviderRevokeRoute(route, state)
  );
  // #870/H1: mark a provider the instance default. Register before the detail route so the more
  // specific `/default` path wins.
  await page.route(/\/api\/ai\/providers\/[^/]+\/default$/, (route) =>
    handleAiProviderSetDefaultRoute(route, state)
  );
  await page.route(/\/api\/ai\/providers\/[^/]+$/, (route) =>
    handleAiProviderDetailRoute(route, state)
  );
  await page.route("**/api/ai/providers", (route) => handleAiProvidersRoute(route, state));
  await page.route(/\/api\/ai\/models\/[^/]+$/, (route) => handleAiModelDetailRoute(route, state));
  await page.route("**/api/ai/models", (route) => handleAiModelsRoute(route, state));
  await page.route(/\/api\/ai\/capability-route\/[^/]+$/, (route) =>
    handleAiCapabilityRoute(route, state)
  );
  await page.route("**/api/ai/service-bindings", (route) => handleAiServiceBindings(route, state));
  await page.route(/\/api\/ai\/services\/[^/]+\/binding$/, (route) =>
    handleAiServiceBinding(route, state)
  );
  await page.route("**/api/ai/chat-model-override", (route) =>
    fulfillJson(route, 200, {
      settings: {
        overrideEnabled: true,
        currentOverrideModelId: null,
        effectiveOverrideModelId: null,
        defaultModel: null,
        selectedModel: null,
        selectableOverrideModels: state.aiModels ?? []
      }
    })
  );
  await page.route("**/api/ai/assistant-tools", (route) =>
    fulfillJson(route, 200, { tools: createMockAiAssistantTools() })
  );
}

async function handleAiProvidersRoute(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { providers: state.aiProviders ?? [] });
  }

  if (request.method() === "POST") {
    const input = request.postDataJSON() as CreateAiProviderConfigRequest;
    const provider = createMockAiProvider(`ai-provider-${(state.aiProviders ?? []).length + 1}`, {
      providerKind: input.providerKind,
      displayName: input.displayName,
      baseUrl: input.baseUrl ?? null,
      status: input.status ?? "active",
      hasCredential: true
    });

    state.aiProviders = [...(state.aiProviders ?? []), provider];
    return fulfillJson(route, 201, { provider });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleAiProviderDetailRoute(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();
  const providerId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const provider = (state.aiProviders ?? []).find((item) => item.id === providerId);

  if (!provider) {
    return fulfillJson(route, 404, { error: "AI provider config not found" });
  }

  if (request.method() !== "PATCH") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const input = request.postDataJSON() as UpdateAiProviderConfigRequest;
  const updatedProvider: AiProviderConfigDto = {
    ...provider,
    providerKind: input.providerKind ?? provider.providerKind,
    displayName: input.displayName ?? provider.displayName,
    baseUrl: input.baseUrl === undefined ? provider.baseUrl : input.baseUrl,
    status: input.status ?? provider.status,
    hasCredential: input.credentialPayload === undefined ? provider.hasCredential : true,
    revokedAt: null,
    updatedAt: "2026-06-06T12:00:00.000Z"
  };

  state.aiProviders = (state.aiProviders ?? []).map((item) =>
    item.id === providerId ? updatedProvider : item
  );
  return fulfillJson(route, 200, { provider: updatedProvider });
}

async function handleAiProviderRevokeRoute(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();
  const segments = new URL(request.url()).pathname.split("/");
  const providerId = decodeURIComponent(segments.at(-2) ?? "");
  const provider = (state.aiProviders ?? []).find((item) => item.id === providerId);

  if (!provider) {
    return fulfillJson(route, 404, { error: "AI provider config not found" });
  }

  if (request.method() !== "POST") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const revokedProvider: AiProviderConfigDto = {
    ...provider,
    status: "revoked",
    revokedAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z"
  };

  state.aiProviders = (state.aiProviders ?? []).map((item) =>
    item.id === providerId ? revokedProvider : item
  );
  return fulfillJson(route, 200, { provider: revokedProvider });
}

async function handleAiModelsRoute(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();

  if (request.method() === "GET") {
    return fulfillJson(route, 200, { models: state.aiModels ?? [] });
  }

  if (request.method() === "POST") {
    const input = request.postDataJSON() as CreateAiConfiguredModelRequest;
    const provider = (state.aiProviders ?? []).find((item) => item.id === input.providerConfigId);

    if (!provider) {
      return fulfillJson(route, 400, { error: "AI configuration request is invalid" });
    }

    const model = createMockAiModel(`ai-model-${(state.aiModels ?? []).length + 1}`, {
      providerConfigId: provider.id,
      providerKind: provider.providerKind,
      providerDisplayName: provider.displayName,
      providerStatus: provider.status,
      providerModelId: input.providerModelId,
      displayName: input.displayName,
      capabilities: input.capabilities,
      status: input.status ?? "active",
      tier: input.tier ?? "interactive",
      allowUserOverride: input.allowUserOverride ?? true,
      origin: "manual"
    });

    state.aiModels = [...(state.aiModels ?? []), model];
    return fulfillJson(route, 201, { model });
  }

  return fulfillJson(route, 405, { error: "Method not allowed" });
}

async function handleAiModelDetailRoute(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();
  const modelId = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
  const model = (state.aiModels ?? []).find((item) => item.id === modelId);

  if (!model) {
    return fulfillJson(route, 404, { error: "AI model config not found" });
  }

  if (request.method() !== "PATCH") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const input = request.postDataJSON() as UpdateAiConfiguredModelRequest;
  const updatedModel: AiConfiguredModelDto = {
    ...model,
    providerModelId: input.providerModelId ?? model.providerModelId,
    displayName: input.displayName ?? model.displayName,
    capabilities: input.capabilities ?? model.capabilities,
    status: input.status ?? model.status,
    updatedAt: "2026-06-06T12:00:00.000Z"
  };

  state.aiModels = (state.aiModels ?? []).map((item) =>
    item.id === modelId ? updatedModel : item
  );
  return fulfillJson(route, 200, { model: updatedModel });
}

// #870 Slice 1: the lookup endpoint resolves a user-facing service to its effective model. A model
// binding names an exact model; a mode binding (or no binding) resolves an active compatible model
// inside the instance-default provider. An unresolved user-facing service reports `needs-config`.
async function handleAiCapabilityRoute(route: Route, state: MockAiApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const capability = decodeURIComponent(
    new URL(route.request().url()).pathname.split("/").pop() ?? ""
  ) as AiModelCapability;
  const binding = state.aiServiceBindings?.[capability];

  if (binding?.kind === "model") {
    const model = findCompatibleModel(state, capability, binding.modelId);
    return fulfillJson(route, 200, {
      route: {
        capability,
        available: Boolean(model),
        reason: model ? "matched-active-model" : "needs-config",
        model: model ?? null
      }
    });
  }

  // Mode binding (or unbound): resolve inside the instance-default provider.
  const defaultProvider = (state.aiProviders ?? []).find(
    (p) => p.isInstanceDefault && p.status === "active"
  );
  const model =
    (state.aiModels ?? []).find(
      (item) =>
        item.status === "active" &&
        item.capabilities.includes(capability) &&
        (defaultProvider ? item.providerConfigId === defaultProvider.id : true) &&
        (state.aiProviders ?? []).some(
          (p) => p.id === item.providerConfigId && p.status === "active"
        )
    ) ?? null;

  return fulfillJson(route, 200, {
    route: {
      capability,
      available: Boolean(model),
      reason: model ? "matched-active-model" : "needs-config",
      model
    }
  });
}

async function handleAiServiceBindings(route: Route, state: MockAiApiState): Promise<void> {
  if (route.request().method() !== "GET") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }
  return fulfillJson(route, 200, { bindings: state.aiServiceBindings ?? {} });
}

async function handleAiServiceBinding(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();
  if (request.method() !== "PUT") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  // Path: /api/ai/services/:service/binding
  const service = decodeURIComponent(
    new URL(request.url()).pathname.split("/").slice(-2, -1)[0] ?? ""
  ) as AiServiceKey;
  const input = request.postDataJSON() as PutAiServiceBindingRequest;
  const binding: AiServiceBinding = input.binding;
  state.aiServiceBindings = {
    ...(state.aiServiceBindings ?? {}),
    [service]: binding
  };

  return fulfillJson(route, 200, { service, binding });
}

// #870/H1: setting a provider as the instance default clears the flag on every other provider
// (globally single-valued) and returns the freshly-flagged provider.
async function handleAiProviderSetDefaultRoute(route: Route, state: MockAiApiState): Promise<void> {
  const request = route.request();
  if (request.method() !== "PUT") {
    return fulfillJson(route, 405, { error: "Method not allowed" });
  }

  const providerId = decodeURIComponent(
    new URL(request.url()).pathname.split("/").slice(-2, -1)[0] ?? ""
  );
  let flagged: AiProviderConfigDto | null = null;
  state.aiProviders = (state.aiProviders ?? []).map((provider) => {
    const isDefault = provider.id === providerId;
    const next = { ...provider, isInstanceDefault: isDefault };
    if (isDefault) flagged = next;
    return next;
  });

  return fulfillJson(route, 200, { provider: flagged });
}

function findCompatibleModel(
  state: MockAiApiState,
  capability: AiModelCapability,
  modelId: string
): AiConfiguredModelDto | undefined {
  return (state.aiModels ?? []).find((item) => {
    const provider = (state.aiProviders ?? []).find(
      (providerConfig) => providerConfig.id === item.providerConfigId
    );

    return (
      item.id === modelId &&
      item.status === "active" &&
      item.capabilities.includes(capability) &&
      provider?.status === "active"
    );
  });
}

export function createMockAiProvider(
  id: string,
  overrides: Partial<AiProviderConfigDto> = {}
): AiProviderConfigDto {
  return {
    id,
    providerKind: "openai-compatible",
    displayName: "OpenAI Compatible",
    baseUrl: null,
    status: "active",
    authMethod: "api_key",
    executionMode: "interactive",
    hasCredential: true,
    cliAvailable: false,
    // #870/H1: default provider flag; specs opt a provider in explicitly.
    isInstanceDefault: false,
    revokedAt: null,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides
  };
}

export function createMockAiModel(
  id: string,
  overrides: Partial<AiConfiguredModelDto> = {}
): AiConfiguredModelDto {
  return {
    id,
    providerConfigId: "ai-provider-1",
    providerKind: "openai-compatible",
    providerDisplayName: "OpenAI Compatible",
    providerStatus: "active",
    providerModelId: "model-id",
    displayName: "Model",
    capabilities: ["chat"],
    status: "active",
    tier: "interactive",
    allowUserOverride: true,
    origin: "discovered",
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
    ...overrides
  };
}

export function createMockAiAssistantTools(): AiAssistantToolDto[] {
  return [
    {
      moduleId: "tasks",
      moduleName: "Tasks",
      name: "tasks.listVisible",
      description: "List visible tasks.",
      permissionId: "tasks.view",
      risk: "read",
      inputSchema: {
        type: "object"
      },
      outputSchema: null
    },
    {
      moduleId: "tasks",
      moduleName: "Tasks",
      name: "tasks.updateStatus",
      description: "Queue a task status update.",
      permissionId: "tasks.update",
      risk: "write",
      inputSchema: {
        type: "object"
      },
      outputSchema: null
    }
  ];
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}
