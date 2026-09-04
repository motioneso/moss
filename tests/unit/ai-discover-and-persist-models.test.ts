import { describe, expect, it, vi } from "vitest";

import { ModelDiscoveryService } from "@moss/ai";

import { discoverAndPersistModels } from "../../packages/ai/src/discover-and-persist-models.js";

// #2208: a failed, unsupported, or unavailable CLI list must change NOTHING in the database —
// no deletes, no upserts. Only an `ok` list from the runner may reconcile the provider's rows.
describe("discoverAndPersistModels (#2208)", () => {
  const input = {
    actorUserId: "user-a",
    providerId: "prov-1",
    providerKind: "anthropic" as const,
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
    expect(outcome).toEqual({});
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
      { ...input, providerKind: "openai-compatible", authMethod: "api_key" },
      { repository: repository as never, modelDiscovery }
    );
    expect(repository.deleteModelsForProviderExceptSentinel).not.toHaveBeenCalled();
    expect(repository.upsertDiscoveredModels).toHaveBeenCalledTimes(1);
  });
});
