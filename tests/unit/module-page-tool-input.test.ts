import { describe, expect, it } from "vitest";
import {
  modulePageInputDigest,
  modulePageInvokeBody
} from "../../apps/api/src/module-page-tool-input.js";

describe("module page input binding", () => {
  it("ignores object-key order but binds nested values and array order", () => {
    const digest = modulePageInputDigest({ id: "synthetic", value: { b: 2, a: 1 }, rows: [1, 2] });
    expect(modulePageInputDigest({ rows: [1, 2], value: { a: 1, b: 2 }, id: "synthetic" })).toEqual(
      digest
    );
    expect(
      modulePageInputDigest({ id: "synthetic", value: { b: 3, a: 1 }, rows: [1, 2] })
    ).not.toEqual(digest);
    expect(
      modulePageInputDigest({ id: "synthetic", value: { b: 2, a: 1 }, rows: [2, 1] })
    ).not.toEqual(digest);
  });
  it("refuses non-finite, non-JSON and excessively nested values", () => {
    for (const value of [Infinity, NaN, undefined, 1n])
      expect(() => modulePageInputDigest({ value })).toThrow();
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 70; i++) nested = { nested };
    expect(() => modulePageInputDigest(nested)).toThrow(/nesting/);
  });
  it("requires a body object, input object and optional string confirmation id", () => {
    for (const input of [
      null,
      [],
      {},
      { input: null },
      { input: [] },
      { input: {}, extra: true },
      { input: {}, confirmationId: 1 }
    ])
      expect(modulePageInvokeBody(input)).toBeNull();
    expect(modulePageInvokeBody({ input: { id: "synthetic" } })).toEqual({
      input: { id: "synthetic" }
    });
  });
});
