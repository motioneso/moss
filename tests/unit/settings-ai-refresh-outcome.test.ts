import { describe, expect, it } from "vitest";

import { describeRefreshOutcome } from "../../apps/web/src/settings/settings-ai-provider-models.js";

// #2208: the one line Settings shows under a provider's model list after "Refresh models".
describe("describeRefreshOutcome", () => {
  const model = { id: "m1" } as never;

  it("counts the stored models when the list was fetched", () => {
    expect(describeRefreshOutcome({ models: [model, model] })).toBe("Refreshed: 2 models");
    expect(describeRefreshOutcome({ models: [model] })).toBe("Refreshed: 1 model");
    expect(describeRefreshOutcome({ models: [] })).toBe("Refreshed: 0 models");
  });

  it("says why in plain English when nothing could be fetched", () => {
    expect(describeRefreshOutcome({ models: [], reason: "not_logged_in" })).toBe("Not logged in");
    expect(describeRefreshOutcome({ models: [], reason: "unsupported" })).toBe(
      "This provider cannot list its models yet"
    );
    expect(describeRefreshOutcome({ models: [], reason: "unavailable" })).toBe(
      "The sign-in helper is not running"
    );
    expect(describeRefreshOutcome({ models: [], reason: "error", message: "HTTP 503" })).toBe(
      "Could not reach the provider"
    );
  });
});
