import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  ApiKeyChatReadiness,
  type ApiKeyChatReadinessInput
} from "../../packages/ai/src/api-key-chat-readiness.js";
import type { CliToolVersions } from "../../packages/ai/src/cli-tool-versions.js";
import {
  registerAiProviderValidationRoutes,
  type AiProviderValidationRouteDependencies
} from "../../packages/ai/src/provider-validation-routes.js";

const KEY = "ada-readiness-key-0001";
const INSTALLED: CliToolVersions = {
  providers: { anthropic: "2.1.0", "openai-compatible": "0.40.0", google: null },
  opencode: "1.18.29"
};

function fakeFetch(status = 200) {
  return vi.fn(async () => new Response('{"data":[]}', { status }));
}

function input(overrides: Partial<ApiKeyChatReadinessInput> = {}): ApiKeyChatReadinessInput {
  return {
    providerId: "provider-1",
    providerKind: "anthropic",
    baseUrl: "http://proxy.test",
    updatedAt: new Date("2026-10-10T00:00:00Z"),
    openCredential: () => ({ apiKey: KEY }),
    ...overrides
  };
}

describe("ApiKeyChatReadiness", () => {
  it("is ready when the claude agent is installed and the models list answers", async () => {
    const fetch = fakeFetch();
    const readiness = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => INSTALLED,
      fetch
    });

    await expect(readiness.check(input())).resolves.toBe("ready");
    expect(fetch).toHaveBeenCalledWith(
      "http://proxy.test/v1/models",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": KEY }) })
    );
  });

  it("names a rejected key on 401 and an unreachable provider on other failures", async () => {
    const reader = async () => INSTALLED;
    const refused = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch(401) }).check(
        input()
      )
    ).resolves.toBe("rejected_key");
    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch(500) }).check(
        input()
      )
    ).resolves.toBe("unreachable");
    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: refused }).check(input())
    ).resolves.toBe("unreachable");
  });

  it("checks OpenCode for OpenAI-compatible rows and sends exactly one /v1", async () => {
    const fetch = fakeFetch();
    const readiness = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => INSTALLED,
      fetch
    });

    await expect(
      readiness.check(
        input({ providerKind: "openai-compatible", baseUrl: "http://proxy.test/v1/" })
      )
    ).resolves.toBe("ready");
    expect(fetch).toHaveBeenCalledWith(
      "http://proxy.test/v1/models",
      expect.objectContaining({ headers: { authorization: `Bearer ${KEY}` } })
    );

    const noOpencode = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => ({ ...INSTALLED, opencode: null }),
      fetch: fakeFetch()
    });
    await expect(noOpencode.check(input({ providerKind: "openai-compatible" }))).resolves.toBe(
      "agent_missing"
    );
  });

  it("reports a missing claude agent without calling the provider", async () => {
    const fetch = fakeFetch();
    const readiness = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => ({
        ...INSTALLED,
        providers: { ...INSTALLED.providers, anthropic: null }
      }),
      fetch
    });

    await expect(readiness.check(input())).resolves.toBe("agent_missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing key when it cannot be decrypted or is empty", async () => {
    const reader = async () => INSTALLED;
    const unreadable = input({
      openCredential: () => {
        throw new Error("bad auth tag");
      }
    });

    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch() }).check(
        unreadable
      )
    ).resolves.toBe("needs_key");
    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch() }).check(
        input({ openCredential: () => ({}) })
      )
    ).resolves.toBe("needs_key");
  });

  it("never caches a runner outage", async () => {
    const reader = vi
      .fn<() => Promise<CliToolVersions>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(INSTALLED);
    const readiness = new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch() });

    await expect(readiness.check(input())).resolves.toBe("runner_unavailable");
    await expect(readiness.check(input())).resolves.toBe("ready");
    await expect(new ApiKeyChatReadiness({ fetch: fakeFetch() }).check(input())).resolves.toBe(
      "runner_unavailable"
    );
  });

  it("caches by row and update time, and a cache hit opens no key", async () => {
    const fetch = fakeFetch();
    const openCredential = vi.fn(() => ({ apiKey: KEY }));
    let now = 1_000;
    const readiness = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => INSTALLED,
      fetch,
      now: () => now
    });

    await readiness.check(input({ openCredential }));
    await readiness.check(input({ openCredential }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openCredential).toHaveBeenCalledTimes(1);

    await readiness.check(input({ openCredential, updatedAt: new Date("2026-10-10T00:05:00Z") }));
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 60_001;
    await readiness.check(input({ openCredential }));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

const apiKeyRow = {
  id: "provider-1",
  provider_kind: "anthropic",
  auth_method: "api_key",
  base_url: "http://proxy.test",
  purpose: "assistant",
  status: "active",
  updated_at: new Date("2026-10-10T00:00:00Z"),
  encrypted_credential: { sealed: true }
};

async function routeServer(row: Record<string, unknown>, isAdmin = true) {
  const server = Fastify();
  const dependencies = {
    resolveAccessContext: async () => ({ actorUserId: "admin-1", requestId: "req-1" }),
    dataContext: {
      withDataContext: async (
        _accessContext: unknown,
        run: (db: DataContextDb) => Promise<unknown>
      ) => run({} as DataContextDb)
    },
    repository: {
      getUserById: vi.fn(async () => ({ id: "admin-1", is_instance_admin: isAdmin })),
      selectProviderWithCredential: vi.fn(async () => row)
    },
    secretCipher: { encryptJson: vi.fn(), decryptJson: vi.fn(() => ({ apiKey: KEY })) },
    modelDiscovery: {},
    chatReadiness: new ApiKeyChatReadiness({
      cliToolVersionReader: async () => INSTALLED,
      fetch: fakeFetch()
    })
  } as unknown as AiProviderValidationRouteDependencies;
  registerAiProviderValidationRoutes(server, dependencies);
  await server.ready();
  return server;
}

describe("GET /api/ai/providers/:id/chat-readiness", () => {
  it("returns only the status, never the key", async () => {
    const server = await routeServer(apiKeyRow);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/ai/providers/provider-1/chat-readiness"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      expect(response.body).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["a CLI row", { ...apiKeyRow, auth_method: "cli" }],
    ["a Google API-key row", { ...apiKeyRow, provider_kind: "google" }]
  ])("refuses %s with 400", async (_label, row) => {
    const server = await routeServer(row);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/ai/providers/provider-1/chat-readiness"
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("refuses a non-admin with 403", async () => {
    const server = await routeServer(apiKeyRow, false);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/ai/providers/provider-1/chat-readiness"
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});
