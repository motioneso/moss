import { describe, expect, it } from "vitest";

import { ModelDiscoveryService } from "../../packages/ai/src/model-discovery.js";
import {
  discoverProviderModels,
  testProviderCredential
} from "../../packages/ai/src/provider-validation.js";

// System One (TypeSafe) is not OpenAI-compatible: it serves only `GET /v1/models` and
// `POST /v1/systemone`, so validation and discovery must reach the former with a Bearer key and
// infer a json-only, economy model from the `{ models: [{ name }] }` payload.
describe("System One provider plumbing", () => {
  const modelsPayload = { models: [{ name: "jev-latest" }] };

  it("tests the credential against the default TypeSafe base URL with a Bearer header", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(modelsPayload), { status: 200 });
    };

    const result = await testProviderCredential({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-secret" },
      fetch: fakeFetch as typeof fetch
    });

    expect(result).toEqual({
      ok: true,
      providerKind: "system-one",
      message: "Provider credential is valid."
    });
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-secret");
  });

  it("honours a configured base URL for discovery", async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(modelsPayload), { status: 200 });
    };

    const models = await discoverProviderModels({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl: "https://system-one.example.test/",
      credential: { apiKey: "sk-secret" },
      fetch: fakeFetch as typeof fetch
    });

    expect(calls[0]).toBe("https://system-one.example.test/v1/models");
    expect(models).toEqual([
      {
        providerModelId: "jev-latest",
        displayName: "jev-latest",
        capabilities: ["json"],
        tier: "economy"
      }
    ]);
  });

  it("infers json-only, economy models through the discovery service", async () => {
    const service = new ModelDiscoveryService();
    const calls: string[] = [];
    const result = await service.discoverModels("system-one-api", {
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-secret" },
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify(modelsPayload), { status: 200 });
      }) as typeof globalThis.fetch
    });

    expect(calls[0]).toBe("https://api.typesafe.ai/v1/models");
    expect(result.models).toEqual([
      {
        providerModelId: "jev-latest",
        displayName: "jev-latest",
        capabilities: ["json"],
        tier: "economy",
        releasedAt: null
      }
    ]);
  });

  it("fails the test on a rejected credential without leaking the body", async () => {
    const result = await testProviderCredential({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-secret" },
      fetch: (async () => new Response("raw body with sk-secret", { status: 401 })) as typeof fetch
    });

    expect(result).toEqual({
      ok: false,
      providerKind: "system-one",
      message: "Provider rejected the credential."
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });
});
