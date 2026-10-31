// Every worker handler is registered under a dotted lower-case name, the form the manifest uses.
// A bare shorthand entry registers the function under its variable name, which no tool can call.
import { describe, expect, it } from "vitest";

import { HANDLERS } from "../../external-modules/finance/src/worker/registry.js";

describe("finance worker registry", () => {
  it("names every handler with a dotted lower-case key", () => {
    const stray = Object.keys(HANDLERS).filter(
      (key) => !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/u.test(key)
    );

    expect(stray).toEqual([]);
  });

  it("registers a function under every key", () => {
    const missing = Object.entries(HANDLERS)
      .filter(([, factory]) => typeof factory !== "function")
      .map(([key]) => key);

    expect(missing).toEqual([]);
  });

  it("registers the bill clear handler under its tool name only", () => {
    expect(HANDLERS["bill.clear"]).toBeTypeOf("function");
    expect(Object.keys(HANDLERS)).not.toContain("billClearHandler");
  });
});
