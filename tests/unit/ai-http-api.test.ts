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

describe("HttpApiAdapter — anthropic", () => {
  it("calls the anthropic messages endpoint and maps content[0].text", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(urlStr).toBe("https://api.anthropic.com/v1/messages");

      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.model).toBe("claude-3-5-sonnet-20241022");
      expect(body.messages).toEqual([{ role: "user", content: "yo" }]);

      // Headers must include x-api-key and anthropic-version
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-test-anthropic");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");

      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "Hello from Anthropic!" }] }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("anthropic", "sk-test-anthropic", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.generateChat({
      model: anthropicModel,
      messages: [{ role: "user", content: "yo" }]
    });
    expect(out.text).toBe("Hello from Anthropic!");
  });

  it("throws HTTP 401 error without leaking the api key", async () => {
    const fakeFetch = async () => new Response("Unauthorized", { status: 401 });
    const adapter = new HttpApiAdapter("anthropic", "sk-secret-key", {
      fetch: fakeFetch as typeof fetch
    });

    await expect(adapter.generateChat({ model: anthropicModel, messages: [] })).rejects.toThrow(
      /401/
    );

    // Key must NOT appear in error message
    await expect(adapter.generateChat({ model: anthropicModel, messages: [] })).rejects.not.toThrow(
      /sk-secret-key/
    );
  });
});

describe("HttpApiAdapter — openai-compatible", () => {
  it("calls /v1/chat/completions and maps choices[0].message.content", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(urlStr).toBe("https://api.openai.com/v1/chat/completions");

      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.model).toBe("gpt-4o");
      expect(body.messages).toEqual([{ role: "user", content: "hello" }]);

      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-test-openai");

      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello from OpenAI!" } }]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test-openai", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(out.text).toBe("Hello from OpenAI!");
  });

  it("respects a custom baseUrl for openai-compatible providers", async () => {
    const fakeFetch = async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      expect(urlStr).toBe("https://my-proxy.example.com/v1/chat/completions");
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "proxied" } }] }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test-openai", {
      fetch: fakeFetch as typeof fetch,
      baseUrl: "https://my-proxy.example.com"
    });
    const out = await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(out.text).toBe("proxied");
  });

  it("throws without leaking the api key on openai 401", async () => {
    const fakeFetch = async () => new Response("Unauthorized", { status: 401 });
    const adapter = new HttpApiAdapter("openai-compatible", "sk-super-secret", {
      fetch: fakeFetch as typeof fetch
    });

    await expect(adapter.generateChat({ model: openaiModel, messages: [] })).rejects.toThrow(/401/);

    await expect(adapter.generateChat({ model: openaiModel, messages: [] })).rejects.not.toThrow(
      /sk-super-secret/
    );
  });
});

describe("HttpApiAdapter — google", () => {
  it("calls generateContent and maps candidates[0].content.parts[0].text", async () => {
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      // URL includes model id but the API key must NOT appear in the query string
      // (a `?key=` param leaks to external proxy/APM/access logs).
      expect(urlStr).toContain("gemini-2.0-flash");
      expect(urlStr).toContain("generateContent");
      expect(urlStr).not.toContain("key=");
      expect(urlStr).not.toContain("sk-test-google");

      // Key travels in the x-goog-api-key header, never in the URL or Authorization header.
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe("sk-test-google");
      expect(headers.get("authorization")).toBeNull();

      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.contents).toBeDefined();
      expect(body.contents[0].parts[0].text).toBe("hi google");

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Hello from Google!" }],
                role: "model"
              }
            }
          ]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("google", "sk-test-google", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.generateChat({
      model: googleModel,
      messages: [{ role: "user", content: "hi google" }]
    });
    expect(out.text).toBe("Hello from Google!");
  });

  it("throws without leaking the api key on google 403", async () => {
    const fakeFetch = async () => new Response("Forbidden", { status: 403 });
    const adapter = new HttpApiAdapter("google", "goog-secret-key", {
      fetch: fakeFetch as typeof fetch
    });

    await expect(adapter.generateChat({ model: googleModel, messages: [] })).rejects.toThrow(/403/);

    await expect(adapter.generateChat({ model: googleModel, messages: [] })).rejects.not.toThrow(
      /goog-secret-key/
    );
  });
});

describe("HttpApiAdapter — maxOutputTokens (economy envelope)", () => {
  it("clamps the anthropic max_tokens to maxOutputTokens when provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200
      });
    };

    const adapter = new HttpApiAdapter("anthropic", "sk-test-anthropic", {
      fetch: fakeFetch as typeof fetch
    });
    await adapter.generateChat({
      model: anthropicModel,
      messages: [{ role: "user", content: "yo" }],
      maxOutputTokens: 1024
    });
    expect(capturedBody.max_tokens).toBe(1024);
  });

  it("preserves the anthropic default max_tokens (8192) when maxOutputTokens is omitted", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200
      });
    };

    const adapter = new HttpApiAdapter("anthropic", "sk-test-anthropic", {
      fetch: fakeFetch as typeof fetch
    });
    await adapter.generateChat({
      model: anthropicModel,
      messages: [{ role: "user", content: "yo" }]
    });
    expect(capturedBody.max_tokens).toBe(8192);
  });

  it("sets openai-compatible max_tokens only when maxOutputTokens is provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test-openai", {
      fetch: fakeFetch as typeof fetch
    });
    await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 1024
    });
    expect(capturedBody.max_tokens).toBe(1024);
  });

  it("omits openai-compatible max_tokens when maxOutputTokens is absent (no default invented)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test-openai", {
      fetch: fakeFetch as typeof fetch
    });
    await adapter.generateChat({
      model: openaiModel,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(capturedBody.max_tokens).toBeUndefined();
  });

  it("sets google maxOutputTokens via generationConfig only when provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("google", "sk-test-google", {
      fetch: fakeFetch as typeof fetch
    });
    await adapter.generateChat({
      model: googleModel,
      messages: [{ role: "user", content: "hi google" }],
      maxOutputTokens: 1024
    });
    const generationConfig = capturedBody.generationConfig as
      | { maxOutputTokens?: number }
      | undefined;
    expect(generationConfig?.maxOutputTokens).toBe(1024);
  });

  it("omits google generationConfig when maxOutputTokens is absent (no default invented)", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" } }]
        }),
        { status: 200 }
      );
    };

    const adapter = new HttpApiAdapter("google", "sk-test-google", {
      fetch: fakeFetch as typeof fetch
    });
    await adapter.generateChat({
      model: googleModel,
      messages: [{ role: "user", content: "hi google" }]
    });
    expect(capturedBody.generationConfig).toBeUndefined();
  });
});

describe("HttpApiAdapter — onActivity", () => {
  it("emits a status event when onActivity is provided", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), { status: 200 });

    const events: Array<{ kind: string; text: string }> = [];
    const adapter = new HttpApiAdapter("anthropic", "sk-test", {
      fetch: fakeFetch as typeof fetch
    });

    await adapter.generateChat({
      model: anthropicModel,
      messages: [{ role: "user", content: "ping" }],
      onActivity: (e) => events.push(e)
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.kind).toBe("status");
  });
});

describe("HttpApiAdapter — transcribeAudio (#738)", () => {
  it("posts multipart form data to the openai-compatible transcriptions endpoint", async () => {
    let capturedUrl = "";
    let capturedForm: FormData | undefined;
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      capturedForm = init?.body as FormData;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-test-openai");
      return new Response(JSON.stringify({ text: "hello from whisper" }), { status: 200 });
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test-openai", {
      fetch: fakeFetch as typeof fetch
    });
    const out = await adapter.transcribeAudio({
      model: { provider_model_id: "whisper-1" },
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" })
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(capturedForm).toBeInstanceOf(FormData);
    expect(capturedForm?.get("model")).toBe("whisper-1");
    expect(capturedForm?.get("file")).toBeInstanceOf(Blob);
    expect(out.text).toBe("hello from whisper");
  });

  it("respects a configured baseUrl (self-hosted/alternate providers, not hardcoded)", async () => {
    let capturedUrl = "";
    const fakeFetch = async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    };

    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: fakeFetch as typeof fetch,
      baseUrl: "https://self-hosted.example.test"
    });
    await adapter.transcribeAudio({
      model: { provider_model_id: "parakeet-local" },
      audio: new Blob([new Uint8Array([9])])
    });

    expect(capturedUrl).toBe("https://self-hosted.example.test/v1/audio/transcriptions");
  });

  it("rejects anthropic and google — no transcription REST surface behind this adapter", async () => {
    const anthropicAdapter = new HttpApiAdapter("anthropic", "sk-test");
    const googleAdapter = new HttpApiAdapter("google", "sk-test");

    await expect(
      anthropicAdapter.transcribeAudio({
        model: { provider_model_id: "claude-3-5-sonnet-20241022" },
        audio: new Blob([new Uint8Array([1])])
      })
    ).rejects.toThrow(/anthropic/);
    await expect(
      googleAdapter.transcribeAudio({
        model: { provider_model_id: "gemini-2.0-flash" },
        audio: new Blob([new Uint8Array([1])])
      })
    ).rejects.toThrow(/google/);
  });

  it("throws HTTP error without leaking the api key, and never echoes audio bytes", async () => {
    const fakeFetch = async () => new Response("Unauthorized", { status: 401 });
    const adapter = new HttpApiAdapter("openai-compatible", "sk-secret-transcription-key", {
      fetch: fakeFetch as typeof fetch
    });

    await expect(
      adapter.transcribeAudio({
        model: { provider_model_id: "whisper-1" },
        audio: new Blob([new Uint8Array([1, 2, 3])])
      })
    ).rejects.toThrow(/401/);
    await expect(
      adapter.transcribeAudio({
        model: { provider_model_id: "whisper-1" },
        audio: new Blob([new Uint8Array([1, 2, 3])])
      })
    ).rejects.not.toThrow(/sk-secret-transcription-key/);
  });

  it("throws when the provider response has no text field", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test", {
      fetch: fakeFetch as typeof fetch
    });

    await expect(
      adapter.transcribeAudio({
        model: { provider_model_id: "whisper-1" },
        audio: new Blob([new Uint8Array([1])])
      })
    ).rejects.toThrow(/No text field/);
  });
});

describe("HttpApiAdapter - cancellation (#2671)", () => {
  it("passes the caller's abort signal to the web request so the request is cancelled", async () => {
    let seen: AbortSignal | null | undefined;
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init?.signal;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200
      });
    };
    const adapter = new HttpApiAdapter("anthropic", "sk-test", {
      fetch: fakeFetch as typeof fetch
    });
    const controller = new AbortController();
    await adapter.generateChat({
      model: anthropicModel,
      messages: [{ role: "user", content: "yo" }],
      signal: controller.signal
    });
    expect(seen).toBe(controller.signal);
  });
});
