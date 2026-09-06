import { describe, expect, it } from "vitest";

import {
  buildStructuredRequest,
  extractStructuredResult
} from "../../packages/ai/src/adapters/http-api-structured.js";

// #2228 fix round 1, finding 4: the OpenAI structured path accepted nativeSearch but silently
// ignored it (chat completions cannot carry the web_search tool). It now switches to the
// Responses API for that request only, keeps the strict JSON schema, and maps url citations.

const schema = {
  type: "object",
  properties: { results: { type: "array", items: { type: "object" } } },
  required: ["results"],
  additionalProperties: false
};

const input = {
  model: { provider_kind: "openai-compatible" as const, provider_model_id: "gpt-4.1" },
  messages: [{ role: "user" as const, content: "latest on solar tariffs" }],
  schema,
  maxOutputTokens: 800
};

describe("OpenAI structured request with nativeSearch (#2228)", () => {
  it("uses the Responses API with the web_search tool and a strict JSON schema", () => {
    const request = buildStructuredRequest("openai-compatible", "sk-test", null, {
      ...input,
      nativeSearch: true
    });
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.body).toMatchObject({
      model: "gpt-4.1",
      max_output_tokens: 800,
      input: [{ role: "user", content: "latest on solar tariffs" }],
      tools: [{ type: "web_search" }],
      text: { format: { type: "json_schema", name: "structured_output", strict: true, schema } }
    });
    expect(request.body).not.toHaveProperty("response_format");
  });

  it("keeps chat completions when nativeSearch is not requested", () => {
    const request = buildStructuredRequest("openai-compatible", "sk-test", null, input);
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.body).not.toHaveProperty("tools");
    expect(request.body).toHaveProperty("response_format");
  });

  it("reads the JSON object and url citations out of a Responses API payload", () => {
    const result = extractStructuredResult("openai-compatible", {
      output: [
        { type: "web_search_call", status: "completed" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ results: [{ title: "Tariffs", url: "https://a.example/1" }] }),
              annotations: [
                { type: "url_citation", url: "https://a.example/1", title: "Tariffs" },
                { type: "url_citation", url: "https://a.example/1", title: "Tariffs again" },
                { type: "file_citation", file_id: "f1" }
              ]
            }
          ]
        }
      ],
      usage: { input_tokens: 120, output_tokens: 40 }
    });
    expect(result).toEqual({
      rawObject: { results: [{ title: "Tariffs", url: "https://a.example/1" }] },
      usage: { inputTokens: 120, outputTokens: 40 },
      sources: [{ title: "Tariffs", url: "https://a.example/1" }]
    });
  });

  it("still reads a chat completions payload", () => {
    const result = extractStructuredResult("openai-compatible", {
      choices: [{ message: { content: JSON.stringify({ results: [] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    });
    expect(result).toEqual({
      rawObject: { results: [] },
      usage: { inputTokens: 10, outputTokens: 5 }
    });
  });
});

describe("Anthropic structured citations (#2228)", () => {
  it("takes urls from web_search_tool_result blocks as well as text citations", () => {
    const result = extractStructuredResult("anthropic", {
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "solar tariffs" } },
        {
          type: "web_search_tool_result",
          content: [
            { type: "web_search_result", url: "https://b.example/2", title: "Result two" },
            { type: "web_search_result", url: "https://b.example/3", title: "Result three" }
          ]
        },
        {
          type: "text",
          text: "Found it.",
          citations: [
            { type: "web_search_result_location", url: "https://b.example/2", title: "Two" }
          ]
        },
        { type: "tool_use", name: "emit_structured_output", input: { results: [] } }
      ],
      usage: { input_tokens: 5, output_tokens: 6 }
    });
    expect(result).toEqual({
      rawObject: { results: [] },
      usage: { inputTokens: 5, outputTokens: 6 },
      sources: [
        { title: "Result two", url: "https://b.example/2" },
        { title: "Result three", url: "https://b.example/3" }
      ]
    });
  });
});
