import { describe, expect, it } from "vitest";

import { assertGateRunDatabaseAccess } from "@moss/db";

describe("assertGateRunDatabaseAccess (#2989)", () => {
  it("refuses a bare run with one plain line pointing at the verify-gate skill", () => {
    let error: unknown;
    try {
      assertGateRunDatabaseAccess({} as NodeJS.ProcessEnv);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    const lines = (error as Error).message.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("verify-gate skill");
  });

  it("allows a run carrying the gate marker in either name spell", () => {
    expect(() =>
      assertGateRunDatabaseAccess({ JARVIS_GATE_RUN: "1" } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() =>
      assertGateRunDatabaseAccess({ MOSS_GATE_RUN: "1" } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("allows the deliberate dev-database override", () => {
    expect(() =>
      assertGateRunDatabaseAccess({ JARVIS_ALLOW_DIRECT_DB: "1" } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("does not treat other values as consent", () => {
    for (const env of [
      { JARVIS_GATE_RUN: "0" },
      { JARVIS_GATE_RUN: "true" },
      { JARVIS_ALLOW_DIRECT_DB: "yes" }
    ]) {
      expect(() => assertGateRunDatabaseAccess(env as NodeJS.ProcessEnv)).toThrow();
    }
  });
});
