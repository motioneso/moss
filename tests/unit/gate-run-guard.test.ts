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

  describe("UAT stack seed container", () => {
    const stackUrls = {
      JARVIS_BOOTSTRAP_DATABASE_URL: "postgres://postgres:postgres@postgres:5432/jarv1s",
      JARVIS_MIGRATION_DATABASE_URL: "postgres://m:pw@postgres:5432/jarv1s",
      JARVIS_APP_DATABASE_URL: "postgres://a:pw@postgres:5432/jarv1s",
      JARVIS_AUTH_DATABASE_URL: "postgres://u:pw@postgres:5432/jarv1s",
      JARVIS_WORKER_DATABASE_URL: "postgres://w:pw@postgres:5432/jarv1s"
    };

    it("allows the seed flag when every URL names the stack's own database", () => {
      expect(() =>
        assertGateRunDatabaseAccess({
          ...stackUrls,
          JARVIS_UAT_SEED_CONFIRM: "1"
        } as NodeJS.ProcessEnv)
      ).not.toThrow();
    });

    it("refuses the seed flag against the shared dev database", () => {
      // Defaults resolve to the dev host, and a single stray URL is enough to refuse.
      expect(() =>
        assertGateRunDatabaseAccess({ JARVIS_UAT_SEED_CONFIRM: "1" } as NodeJS.ProcessEnv)
      ).toThrow();
      expect(() =>
        assertGateRunDatabaseAccess({
          ...stackUrls,
          JARVIS_APP_DATABASE_URL: "postgres://a:pw@jarv1s-postgres:55433/jarv1s",
          JARVIS_UAT_SEED_CONFIRM: "1"
        } as NodeJS.ProcessEnv)
      ).toThrow();
    });

    it("refuses stack URLs without the seed flag", () => {
      expect(() => assertGateRunDatabaseAccess(stackUrls as NodeJS.ProcessEnv)).toThrow();
    });
  });
});
