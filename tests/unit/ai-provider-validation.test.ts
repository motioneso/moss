import { describe, expect, it } from "vitest";

import {
  discoverProviderModels,
  testProviderCredential
} from "../../packages/ai/src/provider-validation.js";

describe("AI provider validation", () => {
  it("tests openai-compatible providers with Authorization header and baseUrl", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
    };

    const result = await testProviderCredential({
      providerKind: "openai-compatible",
      authMethod: "api_key",
      baseUrl: "https://proxy.example.test",
      credential: { apiKey: "sk-secret" },
      fetch: fakeFetch as typeof fetch
    });

    expect(result).toEqual({
      ok: true,
      providerKind: "openai-compatible",
      message: "Provider credential is valid."
    });
    expect(calls[0]?.url).toBe("https://proxy.example.test/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-secret");
  });

  it("normalizes provider failures without leaking secrets or bodies", async () => {
    const result = await testProviderCredential({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-secret" },
      fetch: (async () => new Response("raw body with sk-secret", { status: 401 })) as typeof fetch
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Provider rejected the credential.");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(JSON.stringify(result)).not.toContain("raw body");
  });

  it("returns unsupported for cli auth without network calls", async () => {
    const result = await testProviderCredential({
      providerKind: "anthropic",
      authMethod: "cli",
      baseUrl: null,
      credential: { cli: true },
      fetch: (async () => {
        throw new Error("should not call fetch");
      }) as typeof fetch
    });

    expect(result).toEqual({
      ok: false,
      providerKind: "anthropic",
      message: "CLI provider testing is not supported yet."
    });
  });

  it("discovers models and suggests conservative capabilities", async () => {
    const models = await discoverProviderModels({
      providerKind: "openai-compatible",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-secret" },
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-vision" }] }), {
          status: 200
        })) as typeof fetch
    });

    expect(models).toEqual([
      {
        providerModelId: "gpt-4o",
        displayName: "gpt-4o",
        // gpt-4o family accepts the Responses API web_search tool (#2228).
        capabilities: ["chat", "tool-use", "json", "summarization", "web-search"],
        tier: "interactive"
      },
      {
        providerModelId: "gpt-4o-vision",
        displayName: "gpt-4o-vision",
        capabilities: ["chat", "tool-use", "json", "summarization", "vision", "web-search"],
        tier: "interactive"
      }
    ]);
  });
});
