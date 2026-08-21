import { describe, expect, it } from "vitest";

import { assertModuleControlPayload } from "../../packages/jobs/src/module-jobs.js";

describe("assertModuleControlPayload", () => {
  it("accepts a reconcile payload with a valid moduleId", () => {
    expect(() =>
      assertModuleControlPayload({ moduleId: "acme", action: "reconcile" })
    ).not.toThrow();
  });

  it("accepts a rescan payload with no moduleId", () => {
    expect(() => assertModuleControlPayload({ action: "rescan" })).not.toThrow();
  });

  it("rejects a rescan payload that also carries a moduleId", () => {
    expect(() =>
      assertModuleControlPayload({ moduleId: "acme", action: "rescan" })
    ).toThrow(/invalid/);
  });

  it("rejects a reconcile payload missing moduleId", () => {
    expect(() => assertModuleControlPayload({ action: "reconcile" })).toThrow(/invalid/);
  });

  it("rejects an unknown action", () => {
    expect(() => assertModuleControlPayload({ moduleId: "acme", action: "bogus" })).toThrow(
      /invalid/
    );
  });

  it("rejects a non-object payload", () => {
    expect(() => assertModuleControlPayload("nope")).toThrow();
    expect(() => assertModuleControlPayload(null)).toThrow();
    expect(() => assertModuleControlPayload(["a"])).toThrow();
  });
});
