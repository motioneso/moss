import { describe, expect, it } from "vitest";
import { inferWebSearchCapability } from "@moss/ai";

describe("inferWebSearchCapability", () => {
  it("gives Claude 3.5 and later web search, but not Claude 3.0 models", () => {
    expect(inferWebSearchCapability("anthropic", "claude-3-5-sonnet-20241022")).toBe(true);
    expect(inferWebSearchCapability("anthropic", "claude-3-7-sonnet-20250219")).toBe(true);
    expect(inferWebSearchCapability("anthropic", "claude-4-opus")).toBe(true);
    expect(inferWebSearchCapability("anthropic", "claude-3-opus-20240229")).toBe(false);
    expect(inferWebSearchCapability("anthropic", "claude-3-haiku-20240307")).toBe(false);
  });

  it("gives gpt-4o, gpt-4.1, and o-series web search, but not gpt-4 or gpt-3.5-turbo", () => {
    expect(inferWebSearchCapability("openai-compatible", "gpt-4o")).toBe(true);
    expect(inferWebSearchCapability("openai-compatible", "gpt-4o-mini")).toBe(true);
    expect(inferWebSearchCapability("openai-compatible", "gpt-4.1")).toBe(true);
    expect(inferWebSearchCapability("openai-compatible", "o1")).toBe(true);
    expect(inferWebSearchCapability("openai-compatible", "o3-mini")).toBe(true);
    expect(inferWebSearchCapability("openai-compatible", "gpt-4")).toBe(false);
    expect(inferWebSearchCapability("openai-compatible", "gpt-3.5-turbo")).toBe(false);
  });

  it("gives Gemini 2 and later web search, but not Gemini 1.5", () => {
    expect(inferWebSearchCapability("google", "gemini-2.0-flash")).toBe(true);
    expect(inferWebSearchCapability("google", "gemini-2.5-pro")).toBe(true);
    expect(inferWebSearchCapability("google", "gemini-1.5-pro")).toBe(false);
  });

  it("never gives Ollama or custom models web search", () => {
    expect(inferWebSearchCapability("ollama", "llama3.1")).toBe(false);
    expect(inferWebSearchCapability("custom", "gpt-4o")).toBe(false);
  });

  it("never gives CLI-discovered models web search, even a normally search-capable id", () => {
    expect(inferWebSearchCapability("anthropic", "claude-3-5-sonnet-20241022", true)).toBe(false);
    expect(inferWebSearchCapability("openai-compatible", "gpt-4o", true)).toBe(false);
  });
});
