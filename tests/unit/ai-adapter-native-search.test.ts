import { describe, it, expect } from "vitest";
import { HttpApiAdapter } from "../../packages/ai/src/adapters/http-api.js";

type ModelStub = { provider_kind: string; provider_model_id: string };

const anthropicModel: ModelStub = {
  provider_kind: "anthropic",
  provider_model_id: "claude-3-5-sonnet-20241022"
};

const openaiModel: ModelStub = {
  provider_kind: "openai-compatible",
  provider_model_id: "gpt-4o"
};

const googleModel: ModelStub = {
  provider_kind: "google",
  provider_model_id: "gemini-2.0-flash"
};

describe("HttpApiAdapter native search — anthropic", () => {
  it("adds the web_search tool and extracts citations from text blocks", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.tools).toEqual([
        { type: "web_search_20250305", name: "web_search", max_uses: 5 }
      ]);

      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "The sky is blue.",
              citations: [{ url: "https://example.com/sky", title: "Sky facts" }]
            }
          ]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("anthropic", "sk-test", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.generateChat({
      model: anthropicModel,
      messages: [{ role: "user", content: "why is the sky blue?" }],
      nativeSearch: true
    });

    expect(out.text).toBe("The sky is blue.");
    expect(out.sources).toEqual([{ title: "Sky facts", url: "https://example.com/sky" }]);
  });

  it("does not add search tools or sources when nativeSearch is not requested", async () => {
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.tools).toBeUndefined();
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), {
        status: 200
      });
    };

    const adapter = new HttpApiAdapter("anthropic", "sk-test", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.generateChat({ model: anthropicModel, messages: [] });
    expect(out.sources).toBeUndefined();
  });
});

describe("HttpApiAdapter native search — openai-compatible", () => {
  it("switches to the responses endpoint and extracts url_citation annotations", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(urlStr).toBe("https://api.openai.com/v1/responses");

      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.tools).toEqual([{ type: "web_search" }]);

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Paris is the capital of France.",
                  annotations: [
                    { type: "url_citation", url: "https://example.com/paris", title: "Paris" }
                  ]
                }
              ]
            }
          ]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "capital of France?" }],
      nativeSearch: true
    });

    expect(out.text).toBe("Paris is the capital of France.");
    expect(out.sources).toEqual([{ title: "Paris", url: "https://example.com/paris" }]);
  });
});

describe("HttpApiAdapter native search — google", () => {
  it("adds the google_search tool and extracts grounding chunks as sources", async () => {
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.tools).toEqual([{ google_search: {} }]);

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "It rains a lot in Seattle." }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: "https://example.com/seattle", title: "Seattle weather" } }
                ]
              }
            }
          ]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("google", "sk-test", { fetch: fakeFetch as typeof fetch });
    const out = await adapter.generateChat({
      model: googleModel,
      messages: [{ role: "user", content: "weather in Seattle?" }],
      nativeSearch: true
    });

    expect(out.text).toBe("It rains a lot in Seattle.");
    expect(out.sources).toEqual([{ title: "Seattle weather", url: "https://example.com/seattle" }]);
  });
});
