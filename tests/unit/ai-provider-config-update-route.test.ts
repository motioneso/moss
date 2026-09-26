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
});
