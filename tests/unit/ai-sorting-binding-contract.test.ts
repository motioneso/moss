import { describe, expect, it } from "vitest";

import {
  SORTING_PROVIDER_KINDS,
  SORTING_SERVICE_KEY,
  aiServiceParamsSchema,
  isSortingProviderKind,
  listAiServiceBindingsResponseSchema
} from "../../packages/shared/src/index.js";

describe("sorting binding contract", () => {
  it("reserves the sorting key", () => {
    expect(SORTING_SERVICE_KEY).toBe("sorting");
  });

  it("only qualifies provider kinds the structured path can run", () => {
    expect([...SORTING_PROVIDER_KINDS].sort()).toEqual([
      "anthropic",
      "google",
      "openai-compatible"
    ]);
    expect(isSortingProviderKind("openai-compatible")).toBe(true);
    expect(isSortingProviderKind("ollama")).toBe(false);
    expect(isSortingProviderKind("custom")).toBe(false);
    expect(isSortingProviderKind(null)).toBe(false);
  });

  it("accepts sorting in the route params and keeps chat and module keys", () => {
    // `ajv` is declared only by @moss/ai, so check the route-param contract through the schema's
    // own pattern instead of compiling the whole schema from the root suite.
    const servicePattern = new RegExp(aiServiceParamsSchema.properties.service.pattern);
    expect(servicePattern.test("sorting")).toBe(true);
    expect(servicePattern.test("chat")).toBe(true);
    expect(servicePattern.test("module.news")).toBe(true);
    expect(servicePattern.test("sortingx")).toBe(false);
    expect(servicePattern.test("json")).toBe(false);
  });

  it("declares sorting in the list response so the serializer keeps it", () => {
    const bindings = listAiServiceBindingsResponseSchema.properties.bindings;
    expect(bindings.properties).toHaveProperty("sorting");
  });
});
