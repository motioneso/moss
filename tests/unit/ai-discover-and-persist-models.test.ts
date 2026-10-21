import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelDiscoveryService } from "@moss/ai";

import { discoverAndPersistModels } from "../../packages/ai/src/discover-and-persist-models.js";

// #2208: a failed, unsupported, or unavailable CLI list must change NOTHING in the database —
// no deletes, no upserts. Only an `ok` list from the runner may reconcile the provider's rows.
describe("discoverAndPersistModels (#2208)", () => {
  const input = {
    actorUserId: "user-a",
    providerId: "prov-1",
    providerKind: "anthropic" as const,
    acpAgentId: "claude-acp",
    authMethod: "cli" as const,
    baseUrl: null,
    credential: { cli: true }
  };
  const scopedDb = {} as never;

  function fakeRepository() {
    return {
      deleteModelsForProviderExceptSentinel: vi.fn().mockResolvedValue(0),
      upsertDiscoveredModels: vi.fn().mockResolvedValue(0)
    };
  }

  it.each(["not_logged_in", "unsupported", "error"] as const)(
    "touches nothing when the runner answers %s",
    async (status) => {
      const repository = fakeRepository();
      const modelDiscovery = new ModelDiscoveryService({
        cliModelLister: async () => ({ status, message: "detail" })
      });
      const outcome = await discoverAndPersistModels(scopedDb, input, {
        repository: repository as never,
        modelDiscovery
      });
      // #2208 slice 4: the refresh route reports this back to Settings.
      expect(outcome).toEqual({ reason: status, message: "detail" });
      expect(repository.deleteModelsForProviderExceptSentinel).not.toHaveBeenCalled();
      expect(repository.upsertDiscoveredModels).not.toHaveBeenCalled();
    }
  );

  it("touches nothing when no runner lister is wired", async () => {
    const repository = fakeRepository();
    await discoverAndPersistModels(scopedDb, input, {
      repository: repository as never,
      modelDiscovery: new ModelDiscoveryService()
    });
    expect(repository.deleteModelsForProviderExceptSentinel).not.toHaveBeenCalled();
    expect(repository.upsertDiscoveredModels).not.toHaveBeenCalled();
  });

  it("reconciles the provider's rows against an ok list (sentinel kept)", async () => {
    const repository = fakeRepository();
    const modelDiscovery = new ModelDiscoveryService({
      cliModelLister: async () => ({
        status: "ok",
        models: [{ id: "claude-fable-5-1" }, { id: "claude-haiku-4-5-20251001" }]
      })
    });
    const outcome = await discoverAndPersistModels(scopedDb, input, {
      repository: repository as never,
      modelDiscovery
    });
    expect(outcome).toEqual({
      discoveredModelIds: ["claude-fable-5-1", "claude-haiku-4-5-20251001"]
    });
    expect(repository.deleteModelsForProviderExceptSentinel).toHaveBeenCalledWith(
      scopedDb,
      "prov-1",
      ["claude-fable-5-1", "claude-haiku-4-5-20251001"]
    );
    expect(repository.upsertDiscoveredModels).toHaveBeenCalledWith(
      scopedDb,
      "prov-1",
      expect.arrayContaining([
        expect.objectContaining({ providerModelId: "claude-fable-5-1", status: "active" })
      ])
    );
  });

  it("never deletes rows for an API-key provider", async () => {
    const repository = fakeRepository();
    const modelDiscovery = new ModelDiscoveryService();
    modelDiscovery.discoverModels = async () => ({
      models: [
        {
          providerModelId: "gpt-x",
          displayName: "gpt-x",
          capabilities: ["chat"],
          tier: "interactive"
        }
      ],
      fromCache: false,
      fromFallback: false,
      cacheExpiresAt: null
    });
    await discoverAndPersistModels(
      scopedDb,
      { ...input, providerKind: "openai-compatible", acpAgentId: null, authMethod: "api_key" },
      { repository: repository as never, modelDiscovery }
    );
    expect(repository.deleteModelsForProviderExceptSentinel).not.toHaveBeenCalled();
    expect(repository.upsertDiscoveredModels).toHaveBeenCalledTimes(1);
  });

  it("reports only the chat ids the provider listed on this run", async () => {
    const repository = fakeRepository();
    const modelDiscovery = new ModelDiscoveryService();
    modelDiscovery.discoverModels = async () => ({
      models: [
        {
          providerModelId: "org/model:tag@v2",
          displayName: "org/model:tag@v2",
          capabilities: ["chat", "tool-use"],
          tier: "interactive"
        },
        {
          providerModelId: "org/vision-only",
          displayName: "org/vision-only",
          capabilities: ["vision"],
          tier: "interactive"
        }
      ],
      fromCache: false,
      fromFallback: false,
      cacheExpiresAt: null
    });
    const outcome = await discoverAndPersistModels(
      scopedDb,
      { ...input, providerKind: "openai-compatible", acpAgentId: null, authMethod: "api_key" },
      { repository: repository as never, modelDiscovery }
    );
    expect(outcome).toEqual({ discoveredModelIds: ["org/model:tag@v2"] });
  });
});

describe("discoverAndPersistModels for API-key rows at a proxy address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubListing(ids: readonly string[]) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    });
    return urls;
  }

  it.each([
    ["openai-compatible", "http://proxy.test/v1"],
    ["openai-compatible", "http://proxy.test/v1/"],
    ["anthropic", "http://proxy.test/v1"],
    ["anthropic", "http://proxy.test/v1/"]
  ] as const)("%s at %s persists the proxy id from one /v1/models", async (kind, baseUrl) => {
    const urls = stubListing(["org/model:tag@v2", "text-embedding-3-small"]);
    const repository = {
      deleteModelsForProviderExceptSentinel: vi.fn().mockResolvedValue(0),
      upsertDiscoveredModels: vi.fn().mockResolvedValue(0)
    };
    const outcome = await discoverAndPersistModels(
      {} as never,
      {
        actorUserId: "user-a",
        providerId: `prov-${kind}`,
        providerKind: kind,
        acpAgentId: null,
        authMethod: "api_key",
        baseUrl,
        credential: { apiKey: "sk-test" }
      },
      { repository: repository as never, modelDiscovery: new ModelDiscoveryService() }
    );

    expect(outcome.reason).toBeUndefined();
    expect(urls).toEqual(["http://proxy.test/v1/models"]);
    expect(repository.deleteModelsForProviderExceptSentinel).not.toHaveBeenCalled();
    const rows = repository.upsertDiscoveredModels.mock.calls[0]?.[2] as {
      providerModelId: string;
      capabilities: string[];
    }[];
    expect(rows.map((row) => row.providerModelId)).toEqual(["org/model:tag@v2"]);
    expect(rows[0]?.capabilities).toContain("chat");
  });
});
