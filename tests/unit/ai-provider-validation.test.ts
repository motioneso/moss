import { describe, expect, it } from "vitest";

import {
  discoverProviderModels,
  PROVIDER_CREDENTIAL_VALID_MESSAGE,
  PROVIDER_REJECTED_CREDENTIAL_MESSAGE,
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

describe("provider model listing drops non-chat models", () => {
  it("lists only chat models when the provider also serves embedding, rerank, speech and image models", async () => {
    const ids = [
      "gpt-4o",
      "text-embedding-3-small",
      "omni-moderation-latest",
      "rerank-english-v3",
      "tts-1",
      "dall-e-3",
      "gpt-image-1"
    ];
    const models = await discoverProviderModels({
      providerKind: "openai-compatible",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "test-key-listing" },
      fetch: (async () =>
        new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          status: 200
        })) as typeof fetch
    });

    expect(models.map((model) => model.providerModelId)).toEqual(["gpt-4o"]);
  });

  it("drops OpenAI-compatible ids outside the model id policy and keeps / : @", async () => {
    const ids = ["test-chat-model", "has space", "org/model:tag@v2", "plus+model"];
    const models = await discoverProviderModels({
      providerKind: "openai-compatible",
      authMethod: "api_key",
      baseUrl: "http://proxy.test",
      credential: { apiKey: "test-key-listing" },
      fetch: (async () =>
        new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          status: 200
        })) as typeof fetch
    });

    expect(models.map((model) => model.providerModelId)).toEqual([
      "test-chat-model",
      "org/model:tag@v2"
    ]);
  });
});

describe("Anthropic API-key checks use the row's address", () => {
  function recordingFetch(status: number) {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "claude-test-model" }] }), { status });
    }) as typeof globalThis.fetch;
    return { urls, fetch };
  }

  it("tests the key against the stored address", async () => {
    const { urls, fetch } = recordingFetch(200);
    const result = await testProviderCredential({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: "http://proxy.test/v1",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(urls).toEqual(["http://proxy.test/v1/models"]);
    expect(result).toMatchObject({ ok: true, message: PROVIDER_CREDENTIAL_VALID_MESSAGE });
  });

  it("reports a 401 from the stored address as a rejected credential", async () => {
    const { fetch } = recordingFetch(401);
    const result = await testProviderCredential({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: "http://proxy.test",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(result).toMatchObject({ ok: false, message: PROVIDER_REJECTED_CREDENTIAL_MESSAGE });
  });

  it("falls back to the public Anthropic address when none is stored", async () => {
    const { urls, fetch } = recordingFetch(200);
    await discoverProviderModels({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(urls).toEqual(["https://api.anthropic.com/v1/models"]);
  });
});

describe("OpenAI-compatible key test uses the normalized address", () => {
  it.each(["http://proxy.test/v1", "http://proxy.test/v1/"])(
    "%s gives one /v1",
    async (baseUrl) => {
      const urls: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: "org/model:tag@v2" }] }), {
          status: 200
        });
      }) as typeof globalThis.fetch;
      await testProviderCredential({
        providerKind: "openai-compatible",
        authMethod: "api_key",
        baseUrl,
        credential: { apiKey: "sk-test" },
        fetch
      });
      expect(urls).toEqual(["http://proxy.test/v1/models"]);
    }
  );
});
