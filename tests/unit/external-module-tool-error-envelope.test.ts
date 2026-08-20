// #1662. A module's tool handler has one way to tell the host a call failed: throw. Anything it
// returns is success. So a module that caught its own error and returned the tree's standard
// `{ status: "error", ... }` envelope was recorded as having worked — the audit row said success
// and the user was told the action executed. These tests pin the translation from that envelope
// into the one thing the gateway understands.
import { describe, expect, it } from "vitest";

import {
  ExternalModuleReportedError,
  externalToolResult
} from "../../apps/api/src/external-module-tools.js";

describe("externalToolResult", () => {
  it("turns a module's error envelope into a throw", () => {
    // The shape every module wrapper produces — see external-modules/finance/src/worker/wrap.ts.
    expect(() =>
      externalToolResult({ status: "error", code: "kv_conflict", message: "key already set" })
    ).toThrow(ExternalModuleReportedError);
  });

  it("still throws when the failing envelope also carries data", () => {
    // The original defect. `data` won, the whole envelope came back as the result, and every
    // consumer reads only `.data` — so the failure was not merely mis-audited, it was invisible.
    expect(() =>
      externalToolResult({ status: "error", code: "fetch_failed", data: { items: [] } })
    ).toThrow(ExternalModuleReportedError);
  });

  it("carries the module's own error code on the throw", () => {
    // The code names a key or a constraint and never record content, so it is safe to keep.
    try {
      externalToolResult({ status: "error", code: "invalid_input" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ExternalModuleReportedError).code).toBe("invalid_input");
    }
  });

  it("tolerates an error envelope with no code", () => {
    // A module is not obliged to supply one, and a missing code must not become its own crash.
    // Asserted as a throw first and a shape second: a bare try/catch reading `.code` would also
    // catch its own "should have thrown" assertion and report undefined, so it would pass against
    // a version of this function that never threw at all.
    expect(() => externalToolResult({ status: "error" })).toThrow(ExternalModuleReportedError);
    const error = (() => {
      try {
        externalToolResult({ status: "error" });
      } catch (caught) {
        return caught as ExternalModuleReportedError;
      }
      return undefined;
    })();
    expect(error?.code).toBeUndefined();
  });

  it("leaves the other status values alone", () => {
    // Every module uses top-level `status` as an envelope field; only "error" means failure.
    // Treating the rest as failures would turn Food's "nothing to do" into a reported crash.
    expect(externalToolResult({ status: "no-op", reason: "meal_not_found" })).toEqual({
      data: { status: "no-op", reason: "meal_not_found" }
    });
    expect(externalToolResult({ status: "recorded" })).toEqual({ data: { status: "recorded" } });
  });

  it("does not treat a nested error status as a failed call", () => {
    // A bank link sitting in an error state, or one failed item inside a sync, is a fact about
    // the world that the call successfully retrieved. Recursing here would report a working
    // tool as broken every time it honestly described something broken.
    expect(externalToolResult({ status: "ok", items: [{ id: "a", status: "error" }] })).toEqual({
      data: { status: "ok", items: [{ id: "a", status: "error" }] }
    });
  });

  it("passes a well-formed result envelope through untouched", () => {
    expect(externalToolResult({ data: { meals: [] }, columnOrder: ["name"] })).toEqual({
      data: { meals: [] },
      columnOrder: ["name"]
    });
  });

  it("wraps a bare object and a non-object alike", () => {
    expect(externalToolResult({ meals: [] })).toEqual({ data: { meals: [] } });
    expect(externalToolResult("done")).toEqual({ data: { value: "done" } });
    expect(externalToolResult(null)).toEqual({ data: { value: null } });
  });
});
