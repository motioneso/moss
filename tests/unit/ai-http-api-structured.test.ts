import { describe, expect, it } from "vitest";

import { HttpApiAdapter } from "../../packages/ai/src/adapters/http-api.js";
import {
  GATE_TIMEOUT_ABORT_REASON,
  type ModelActivityEntry
} from "../../packages/ai/src/model-activity.js";
import {
  STRUCTURED_TOOL_NAME,
  StructuredOutputParseError,
  buildStructuredRequest,
  extractStructuredResult,
  type GenerateStructuredProviderInput
} from "../../packages/ai/src/adapters/http-api-structured.js";

const schema = { type: "object", properties: { a: { type: "string" } } };

function makeInput(
  overrides: Partial<GenerateStructuredProviderInput> = {}
): GenerateStructuredProviderInput {
  return {
    model: { provider_kind: "anthropic", provider_model_id: "claude-x" },
    messages: [{ role: "user", content: "hi" }],
    schema,
    maxOutputTokens: 512,
    ...overrides
  };
}

describe("buildStructuredRequest", () => {
  it("anthropic: forced tool call, x-api-key header, versioned", () => {
    const request = buildStructuredRequest("anthropic", "sk-a", null, makeInput());
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-a");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.body.tool_choice).toEqual({ type: "tool", name: STRUCTURED_TOOL_NAME });
    const tools = request.body.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools[0]!.name).toBe(STRUCTURED_TOOL_NAME);
    expect(tools[0]!.input_schema).toBe(schema);
    expect(request.body.max_tokens).toBe(512);
  });

  it("openai-compatible: strict json_schema response_format, Bearer auth, custom base URL", () => {
    const request = buildStructuredRequest(
      "openai-compatible",
      "sk-o",
      "https://llm.internal",
      makeInput()
    );
    expect(request.url).toBe("https://llm.internal/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer sk-o");
    expect(request.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "structured_output", strict: true, schema }
    });
  });

  it("google: responseSchema generationConfig, key in HEADER never URL, assistant→model role", () => {
    const request = buildStructuredRequest(
      "google",
      "sk-g",
      null,
      makeInput({
        messages: [
          { role: "assistant", content: "prev" },
          { role: "user", content: "hi" }
        ]
      })
    );
    expect(request.url).not.toContain("sk-g");
    expect(request.headers["x-goog-api-key"]).toBe("sk-g");
    const body = request.body as {
      contents: Array<{ role: string }>;
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0]!.role).toBe("model");
    expect(body.contents[1]!.role).toBe("user");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBe(schema);
  });
});

describe("extractStructuredResult", () => {
  it("anthropic: reads the forced tool_use input and usage", () => {
    const result = extractStructuredResult("anthropic", {
      content: [{ type: "tool_use", name: STRUCTURED_TOOL_NAME, input: { a: "b" } }],
      usage: { input_tokens: 3, output_tokens: 2 }
    });
    expect(result).toEqual({ rawObject: { a: "b" }, usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it("anthropic: a chatty non-tool response throws a repairable parse error", () => {
    expect(() =>
      extractStructuredResult("anthropic", {
        content: [{ type: "text", text: "sure! here you go..." }],
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    ).toThrow(StructuredOutputParseError);
  });

  it("openai-compatible: parses JSON content and maps usage", () => {
    const result = extractStructuredResult("openai-compatible", {
      choices: [{ message: { content: '{"a":"b"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 4 }
    });
    expect(result).toEqual({ rawObject: { a: "b" }, usage: { inputTokens: 5, outputTokens: 4 } });
  });

  it("google: joins text parts and parses", () => {
    const result = extractStructuredResult("google", {
      candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '"b"}' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 }
    });
    expect(result).toEqual({ rawObject: { a: "b" }, usage: { inputTokens: 2, outputTokens: 1 } });
  });

  it("invalid JSON throws a parse error carrying rawText + usage", () => {
    try {
      extractStructuredResult("openai-compatible", {
        choices: [{ message: { content: "not json" } }],
        usage: { prompt_tokens: 9, completion_tokens: 8 }
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputParseError);
      const parseError = error as StructuredOutputParseError;
      expect(parseError.usage).toEqual({ inputTokens: 9, outputTokens: 8 });
      expect(parseError.rawText).toBe("not json");
    }
  });
});

describe("HttpApiAdapter.generateStructured", () => {
  it("POSTs the built request, threads the AbortSignal, and returns the extracted result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const controller = new AbortController();
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "tool_use", name: STRUCTURED_TOOL_NAME, input: { a: "b" } }],
          usage: { input_tokens: 3, output_tokens: 2 }
        })
      };
    }) as unknown as typeof globalThis.fetch;

    const adapter = new HttpApiAdapter("anthropic", "sk-secret", { fetch: fakeFetch });
    const result = await adapter.generateStructured(makeInput({ signal: controller.signal }));

    expect(result).toEqual({ rawObject: { a: "b" }, usage: { inputTokens: 3, outputTokens: 2 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("HTTP errors surface status only — never the API key", async () => {
    const fake500 = (async () => ({
      ok: false,
      status: 500
    })) as unknown as typeof globalThis.fetch;
    const adapter = new HttpApiAdapter("anthropic", "sk-secret", { fetch: fake500 });

    const error = await adapter.generateStructured(makeInput()).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("AI provider request failed: HTTP 500");
    expect((error as Error).message).not.toContain("sk-secret");
  });

  it("files no activity line when the gate deadline aborts the fetch mid-request (#3064)", async () => {
    // Real fetch rejects with a bare abort error that drops the signal's reason. The
    // adapter re-wraps it with the gate's reason so the recorder (which skips
    // gate-timeout aborts, leaving the single line to the gate) files nothing.
    const entries: ModelActivityEntry[] = [];
    const controller = new AbortController();
    const fakeFetch = ((url: string, init: RequestInit) => {
      void url;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new HttpApiAdapter("anthropic", "sk-secret", {
      fetch: fakeFetch,
      onModelCall: (entry) => entries.push(entry)
    });

    const pending = adapter.generateStructured(makeInput({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(GATE_TIMEOUT_ABORT_REASON);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(entries).toEqual([]);
  });
});
