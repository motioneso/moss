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

  it("says the service does not list its models when the model list is a 404", async () => {
    const result = await testProviderCredential({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-secret" },
      fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch
    });

    expect(result).toEqual({
      ok: false,
      providerKind: "system-one",
      message:
        "This service does not list its models, so the key could not be checked. Add a model by hand, then try it."
    });
    expect(result.message).not.toBe("Provider rejected the credential.");
  });
});

// #3057: a Cloudflare decision model has no models list, so Test sends one fixed probe through the
// same address the sender uses and passes on a 2xx with `success: true`.
describe("Cloudflare decision-model Test (#3057)", () => {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${"0123456789abcdef0123456789abcdef"}/ai`;
  const probeUrl = `${baseUrl}/run/@cf/cloudflare/clef-flash`;

  it("sends the one-question probe to clef-flash and passes on success", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, result: { answers: {} } }), {
        status: 200
      });
    };

    const result = await testProviderCredential({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl,
      credential: { apiKey: "cf-token" },
      fetch: fakeFetch as typeof fetch
    });

    expect(result).toEqual({
      ok: true,
      providerKind: "system-one",
      message: "Provider credential is valid."
    });
    expect(calls[0]?.url).toBe(probeUrl);
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("clef-flash");
    expect(body.questions).toMatchObject({ reachable: { type: "noul" } });
    expect(JSON.stringify(body)).not.toContain("cf-token");
  });

  it("treats a Cloudflare success:false answer as a failed test", async () => {
    const result = await testProviderCredential({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl,
      credential: { apiKey: "cf-token" },
      fetch: (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 7000 }] }), {
          status: 200
        })) as typeof fetch
    });

    expect(result).toEqual({
      ok: false,
      providerKind: "system-one",
      message: "Provider test failed."
    });
  });

  it("reports a rejected Cloudflare token as a rejected credential", async () => {
    const result = await testProviderCredential({
      providerKind: "system-one",
      authMethod: "api_key",
      baseUrl,
      credential: { apiKey: "cf-token" },
      fetch: (async () => new Response("{}", { status: 403 })) as typeof fetch
    });

    expect(result).toEqual({
      ok: false,
      providerKind: "system-one",
      message: "Provider rejected the credential."
    });
  });
});
