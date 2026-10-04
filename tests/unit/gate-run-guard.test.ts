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

    it("refuses an address whose query options can redirect the driver", () => {
      // The driver lets ?host=, ?port=, ?dbname= and similar override the address,
      // so a URL that looks like the stack can still reach the shared dev database.
      for (const query of [
        "?host=jarv1s-postgres",
        "?host=/var/run/postgresql",
        "?port=55433",
        "?dbname=other",
        "?hostaddr=192.0.2.1",
        "?sslmode=disable"
      ]) {
        expect(() =>
          assertGateRunDatabaseAccess({
            ...stackUrls,
            JARVIS_APP_DATABASE_URL: `postgres://a:pw@postgres:5432/jarv1s${query}`,
            JARVIS_UAT_SEED_CONFIRM: "1"
          } as NodeJS.ProcessEnv)
        ).toThrow();
      }
    });

    it("refuses socket-style and other non-postgres address forms", () => {
      for (const url of [
        "socket://postgres:5432/jarv1s",
        "socket:///var/run/postgresql jarv1s",
        "socket://postgres/var/run/postgresql:jarv1s",
        "postgres://%2Fvar%2Frun%2Fpostgresql/jarv1s",
        "postgres:///jarv1s",
        "http://postgres:5432/jarv1s",
        "postgresql+unix://postgres/jarv1s"
      ]) {
        expect(() =>
          assertGateRunDatabaseAccess({
            ...stackUrls,
            JARVIS_APP_DATABASE_URL: url,
            JARVIS_UAT_SEED_CONFIRM: "1"
          } as NodeJS.ProcessEnv)
        ).toThrow();
      }
    });

    it("accepts the postgresql:// spelling of a stack address", () => {
      expect(() =>
        assertGateRunDatabaseAccess({
          ...stackUrls,
          JARVIS_APP_DATABASE_URL: "postgresql://a:pw@postgres:5432/jarv1s",
          JARVIS_UAT_SEED_CONFIRM: "1"
        } as NodeJS.ProcessEnv)
      ).not.toThrow();
    });

    it("refuses a stack address on another port", () => {
      expect(() =>
        assertGateRunDatabaseAccess({
          ...stackUrls,
          JARVIS_APP_DATABASE_URL: "postgres://a:pw@postgres:55433/jarv1s",
          JARVIS_UAT_SEED_CONFIRM: "1"
        } as NodeJS.ProcessEnv)
      ).toThrow();
    });

    it("refuses stack URLs without the seed flag", () => {
      expect(() => assertGateRunDatabaseAccess(stackUrls as NodeJS.ProcessEnv)).toThrow();
    });
  });
});
