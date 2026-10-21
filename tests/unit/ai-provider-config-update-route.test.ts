import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import { registerAiRoutes, type AiRoutesDependencies } from "../../packages/ai/src/routes.js";

describe("PATCH /api/ai/providers/:id", () => {
  it("allows unrelated edits to a legacy CLI provider with no supported ACP identity", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const provider = {
      id: "provider-legacy",
      owner_user_id: "admin-1",
      provider_kind: "ollama",
      acp_agent_id: null,
      display_name: "Legacy Ollama",
      base_url: null,
      status: "active",
      auth_method: "cli",
      execution_mode: "non_interactive",
      has_credential: false,
      is_instance_default: false,
      purpose: "assistant",
      revoked_at: null,
      created_at: now,
      updated_at: now
    };
    const updateProvider = vi.fn().mockResolvedValue({ ...provider, status: "disabled" });
    const repository = {
      getUserById: vi.fn().mockResolvedValue({ is_instance_admin: true }),
      listProviders: vi.fn().mockResolvedValue([provider]),
      updateProvider
    };
    const server = Fastify();
    const dependencies = {
      resolveAccessContext: async () => ({ actorUserId: "admin-1", requestId: "req-1" }),
      dataContext: {
        withDataContext: async (
          _accessContext: unknown,
          run: (db: DataContextDb) => Promise<unknown>
        ) => run({} as DataContextDb)
      },
      resolveActiveModules: () => [],
      repository,
      secretCipher: {
        encryptJson: vi.fn(),
        decryptJson: vi.fn()
      }
    } as unknown as AiRoutesDependencies;

    registerAiRoutes(server, dependencies);
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-legacy",
        payload: { status: "disabled" }
      });

      expect(response.statusCode).toBe(200);
      expect(updateProvider).toHaveBeenCalledWith(
        expect.anything(),
        "provider-legacy",
        expect.objectContaining({ status: "disabled", acpAgentId: null })
      );
    } finally {
      await server.close();
    }
  });

  it("removes stale models and ensures a default when switching a CLI provider to OpenCode", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const provider = {
      id: "provider-1",
      owner_user_id: "admin-1",
      provider_kind: "openai-compatible",
      acp_agent_id: "codex-acp",
      display_name: "OpenAI",
      base_url: null,
      status: "active",
      auth_method: "cli",
      execution_mode: "non_interactive",
      has_credential: false,
      is_instance_default: true,
      purpose: "assistant",
      revoked_at: null,
      created_at: now,
      updated_at: now
    };
    const updatedProvider = { ...provider, acp_agent_id: "opencode" };
    const updateProvider = vi.fn().mockResolvedValue(updatedProvider);
    const deleteModelsForProviderExceptSentinel = vi.fn().mockResolvedValue(undefined);
    const createModel = vi.fn().mockResolvedValue({ id: "default-model" });
    const repository = {
      getUserById: vi.fn().mockResolvedValue({ is_instance_admin: true }),
      listProviders: vi.fn().mockResolvedValue([provider]),
      updateProvider,
      selectProviderWithCredential: vi.fn().mockResolvedValue({ encrypted_credential: null }),
      listModels: vi.fn().mockResolvedValue([
        {
          id: "stale-codex-model",
          provider_config_id: provider.id,
          provider_model_id: "gpt-5.6",
          display_name: "Codex model",
          origin: "discovered"
        }
      ]),
      deleteModelsForProviderExceptSentinel,
      createModel
    };
    const server = Fastify();
    const dependencies = {
      resolveAccessContext: async () => ({ actorUserId: "admin-1", requestId: "req-1" }),
      dataContext: {
        withDataContext: async (
          _accessContext: unknown,
          run: (db: DataContextDb) => Promise<unknown>
        ) => run({} as DataContextDb)
      },
      resolveActiveModules: () => [],
      repository,
      modelDiscovery: {
        invalidate: vi.fn(),
        discoverModels: vi.fn().mockResolvedValue({
          models: [],
          fromCache: false,
          fromFallback: false,
          cacheExpiresAt: null,
          reason: "unsupported"
        })
      },
      secretCipher: {
        encryptJson: vi.fn(),
        decryptJson: vi.fn()
      }
    } as unknown as AiRoutesDependencies;

    registerAiRoutes(server, dependencies);
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-1",
        payload: { acpAgentId: "opencode" }
      });

      expect(response.statusCode).toBe(200);
      expect(updateProvider).toHaveBeenCalledWith(
        expect.anything(),
        "provider-1",
        expect.objectContaining({ acpAgentId: "opencode" })
      );
      expect(deleteModelsForProviderExceptSentinel).toHaveBeenCalledWith(
        expect.anything(),
        "provider-1"
      );
      expect(createModel).toHaveBeenCalledWith(expect.anything(), {
        providerConfigId: "provider-1",
        providerModelId: "default",
        displayName: "OpenCode (default model)",
        capabilities: ["chat"],
        status: "active",
        tier: "interactive"
      });
    } finally {
      await server.close();
    }
  });
});

describe("provider saves drop the row's live chats", () => {
  const now = new Date("2026-10-11T00:00:00Z");
  const provider = {
    id: "provider-key",
    owner_user_id: "admin-1",
    provider_kind: "openai-compatible",
    acp_agent_id: null,
    display_name: "Proxy",
    base_url: "http://proxy.test",
    status: "active",
    auth_method: "api_key",
    execution_mode: "non_interactive",
    has_credential: true,
    is_instance_default: false,
    purpose: "assistant",
    revoked_at: null,
    created_at: now,
    updated_at: now
  };

  function app(drop = vi.fn().mockResolvedValue(undefined)) {
    const repository = {
      getUserById: vi.fn().mockResolvedValue({ is_instance_admin: true }),
      listProviders: vi.fn().mockResolvedValue([provider]),
      updateProvider: vi.fn().mockResolvedValue(provider),
      revokeProvider: vi
        .fn()
        .mockResolvedValue({ ...provider, status: "revoked", revoked_at: now }),
      selectProviderWithCredential: vi.fn().mockResolvedValue(undefined)
    };
    const server = Fastify();
    registerAiRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: "admin-1", requestId: "req-1" }),
      dataContext: {
        withDataContext: async (
          _accessContext: unknown,
          run: (db: DataContextDb) => Promise<unknown>
        ) => run({} as DataContextDb)
      },
      resolveActiveModules: () => [],
      repository,
      secretCipher: { encryptJson: vi.fn(() => ({ sealed: true })), decryptJson: vi.fn() },
      dropChatSessionsForProviderConfig: drop
    } as unknown as AiRoutesDependencies);
    return { server, drop };
  }

  it.each([
    ["a new key", { credentialPayload: { apiKey: "localproxy0007neverlog" } }],
    ["a new address", { baseUrl: "http://proxy.test/other" }]
  ])("drops them after saving %s", async (_label, payload) => {
    const { server, drop } = app();
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-key",
        payload
      });
      expect(response.statusCode).toBe(200);
      expect(drop).toHaveBeenCalledWith("provider-key");
    } finally {
      await server.close();
    }
  });

  it("keeps them when only the status changes", async () => {
    const { server, drop } = app();
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-key",
        payload: { status: "disabled" }
      });
      expect(response.statusCode).toBe(200);
      expect(drop).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("drops them after revoke", async () => {
    const { server, drop } = app();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/ai/providers/provider-key/revoke"
      });
      expect(response.statusCode).toBe(200);
      expect(drop).toHaveBeenCalledWith("provider-key");
    } finally {
      await server.close();
    }
  });

  it("still saves when the drop fails", async () => {
    const { server } = app(vi.fn().mockRejectedValue(new Error("runner unavailable")));
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-key",
        payload: { credentialPayload: { apiKey: "localproxy0007neverlog" } }
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
