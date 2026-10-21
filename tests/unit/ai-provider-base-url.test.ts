import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
  PROVIDER_MODEL_ID_PATTERN,
  providerBaseUrl
} from "../../packages/ai/src/provider-base-url.js";

describe("providerBaseUrl", () => {
  it.each([
    ["anthropic", null, ANTHROPIC_DEFAULT_BASE_URL],
    ["anthropic", undefined, ANTHROPIC_DEFAULT_BASE_URL],
    ["anthropic", "   ", ANTHROPIC_DEFAULT_BASE_URL],
    ["anthropic", "http://proxy.test", "http://proxy.test"],
    ["anthropic", "http://proxy.test/", "http://proxy.test"],
    ["anthropic", "http://proxy.test/v1", "http://proxy.test"],
    ["anthropic", "http://proxy.test/v1/", "http://proxy.test"],
    ["anthropic", " http://proxy.test/gateway/v1 ", "http://proxy.test/gateway"],
    ["openai-compatible", null, OPENAI_DEFAULT_BASE_URL],
    ["openai-compatible", "http://proxy.test/v1//", "http://proxy.test"]
  ] as const)("%s %j gives %s", (kind, stored, expected) => {
    expect(providerBaseUrl(kind, stored)).toBe(expected);
  });

  it("keeps a last path segment that merely ends in v1", () => {
    expect(providerBaseUrl("anthropic", "http://proxy.test/apiv1")).toBe("http://proxy.test/apiv1");
  });
});

describe("PROVIDER_MODEL_ID_PATTERN", () => {
  it.each(["claude-sonnet-4-5", "org/model:tag@v2", "gpt-4.1-mini", "a"])("accepts %s", (id) => {
    expect(PROVIDER_MODEL_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(["", "has space", "semi;colon", 'quote"', "new\nline", "x".repeat(201)])(
    "refuses %j",
    (id) => {
      expect(PROVIDER_MODEL_ID_PATTERN.test(id)).toBe(false);
    }
  );
});
