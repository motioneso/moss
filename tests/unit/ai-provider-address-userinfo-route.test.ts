import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb } from "@moss/db";
import { registerAiRoutes, type AiRoutesDependencies } from "../../packages/ai/src/routes.js";

const providerId = "62000000-0000-4000-8000-000000000002";
const MESSAGE = "A provider address cannot include a username or password.";

function harness() {
  const withDataContext = vi.fn(
    async (_context: AccessContext, run: (db: DataContextDb) => Promise<unknown>) =>
      run({} as DataContextDb)
  );
  const dependencies = {
    resolveAccessContext: async () => ({ actorUserId: "admin-a", requestId: "request-1" }),
    dataContext: { withDataContext },
    resolveActiveModules: () => [],
    repository: {},
    secretCipher: { encryptJson: vi.fn(() => "sealed"), decryptJson: vi.fn() }
  } as unknown as AiRoutesDependencies;
  const server = Fastify();
  registerAiRoutes(server, dependencies);
  return { server, withDataContext };
}

describe("AI provider address with a username or password", () => {
  it.each([
    [
      "create",
      "POST",
      "/api/ai/providers",
      {
        providerKind: "openai-compatible",
        displayName: "Proxy",
        baseUrl: "http://user:hunter2pw@proxy.test/v1",
        credentialPayload: { apiKey: "test-key-0001" }
      }
    ],
    [
      "update",
      "PATCH",
      `/api/ai/providers/${providerId}`,
      { baseUrl: "https://hunter2user@proxy.test" }
    ]
  ] as const)("refuses it on %s without echoing the address", async (_label, method, url, body) => {
    const { server, withDataContext } = harness();
    try {
      const response = await server.inject({ method, url, payload: body });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: MESSAGE });
      expect(response.body).not.toMatch(/hunter2|proxy\.test/);
      expect(withDataContext).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
