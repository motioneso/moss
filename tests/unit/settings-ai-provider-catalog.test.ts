import { describe, expect, it } from "vitest";

import { PROVIDER_CATALOG } from "../../apps/web/src/settings/settings-ai-provider-catalog.js";

describe("provider catalog", () => {
  it("offers Anthropic by API key next to the Anthropic CLI entry", () => {
    const labels = PROVIDER_CATALOG.map((entry) => entry.label);
    expect(PROVIDER_CATALOG).toContainEqual({
      label: "Anthropic (API key)",
      kind: "anthropic",
      authMethod: "api_key"
    });
    expect(labels.indexOf("Anthropic (API key)")).toBe(labels.indexOf("Anthropic") + 1);
  });

  it("keeps every label unique, because added entries are matched by label", () => {
    const labels = PROVIDER_CATALOG.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
