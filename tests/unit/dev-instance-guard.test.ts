import { describe, expect, it } from "vitest";

import {
  assertDevEnvParity,
  assertTargetIsDevInstance,
  DEV_INSTANCE_MIGRATION_PORTS,
  DevEnvParityError,
  NotDevInstanceError
} from "../../scripts/dev-instance/guard.js";
import { runDevInstanceCli } from "../../scripts/dev-instance.js";

const DEV_APP_URL = "postgres://jarvis_app_runtime:pw@localhost:55433/jarv1s";

describe("assertTargetIsDevInstance", () => {
  it("throws NotDevInstanceError for a database name that is not jarv1s", () => {
    expect(() =>
      assertTargetIsDevInstance("postgres://user:pw@localhost:55433/some_other_db")
    ).toThrow(NotDevInstanceError);
  });

  it("throws NotDevInstanceError for port 5432 instead of 55433", () => {
    expect(() => assertTargetIsDevInstance("postgres://user:pw@localhost:5432/jarv1s")).toThrow(
      NotDevInstanceError
    );
  });

  it("throws NotDevInstanceError for a string that is not a parseable URL", () => {
    expect(() => assertTargetIsDevInstance("not a url at all")).toThrow(NotDevInstanceError);
  });

  it("throws NotDevInstanceError for an empty string", () => {
    expect(() => assertTargetIsDevInstance("")).toThrow(NotDevInstanceError);
  });

  it("accepts the real dev app URL", () => {
    expect(() => assertTargetIsDevInstance(DEV_APP_URL)).not.toThrow();
  });

  it("with the migration port allowlist, still rejects a database name off the allowlist", () => {
    expect(() =>
      assertTargetIsDevInstance(
        "postgres://jarvis_migration_owner:pw@postgres:5432/some_other_db",
        DEV_INSTANCE_MIGRATION_PORTS
      )
    ).toThrow(NotDevInstanceError);
  });

  it("with the migration port allowlist, accepts the in-container migration URL on port 5432", () => {
    expect(() =>
      assertTargetIsDevInstance(
        "postgres://jarvis_migration_owner:pw@postgres:5432/jarv1s",
        DEV_INSTANCE_MIGRATION_PORTS
      )
    ).not.toThrow();
  });

  it("without the migration port allowlist, still rejects port 5432 (default allowlist unchanged)", () => {
    expect(() => assertTargetIsDevInstance("postgres://user:pw@localhost:5432/jarv1s")).toThrow(
      NotDevInstanceError
    );
  });
});

describe("assertDevEnvParity", () => {
  it("throws DevEnvParityError when NODE_ENV is production", () => {
    expect(() => assertDevEnvParity({ NODE_ENV: "production" })).toThrow(DevEnvParityError);
  });

  it("throws DevEnvParityError when NODE_ENV is development", () => {
    expect(() => assertDevEnvParity({ NODE_ENV: "development" })).toThrow(DevEnvParityError);
  });

  it("throws DevEnvParityError when NODE_ENV is test", () => {
    expect(() => assertDevEnvParity({ NODE_ENV: "test" })).toThrow(DevEnvParityError);
  });

  it("passes when NODE_ENV is absent", () => {
    expect(() => assertDevEnvParity({})).not.toThrow();
  });
});

// T19 — the CLI's guard ordering. NODE_ENV being set must fail the run before any database
// handle opens, proven by pointing the connection env at a host nothing is listening on: if the
// parity check ran after a connection attempt, this test would hang or fail with a connection
// error instead of returning promptly with the parity message.
describe("runDevInstanceCli guard ordering", () => {
  it("fails on the parity error, without opening a connection, when NODE_ENV is set", async () => {
    const unreachableEnv: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      JARVIS_PGHOST: "192.0.2.1", // TEST-NET-1 (RFC 5737) — reserved, guaranteed unreachable
      JARVIS_PGPORT: "1"
    };

    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message: string) => {
      messages.push(message);
    };

    let exitCode: number;
    try {
      exitCode = await runDevInstanceCli(["provision"], unreachableEnv);
    } finally {
      console.error = originalError;
    }

    expect(exitCode).not.toBe(0);
    expect(messages.some((message) => message.includes("NODE_ENV"))).toBe(true);
  });

  // #1258 QA finding: the app URL was guarded but the migration-owner URL (which runs every
  // doctor read and the CLI's only DELETE) was not, so a shell with JARVIS_MIGRATION_DATABASE_URL
  // pointing off-box could pass the app guard and still touch the wrong database. Prove the
  // migration URL is rejected before any handle opens, using an unreachable host so a hang or a
  // connection error (rather than a prompt guard rejection) would fail this test.
  it("rejects a divergent JARVIS_MIGRATION_DATABASE_URL before any database handle opens", async () => {
    // JARVIS_PGHOST/PGPORT are deliberately left unset so urls.app resolves to the ordinary
    // localhost:55433 default (passing the app guard) and isolates this test to the migration
    // guard specifically — only JARVIS_MIGRATION_DATABASE_URL diverges, pointing off-box.
    const divergentMigrationEnv: NodeJS.ProcessEnv = {
      JARVIS_MIGRATION_DATABASE_URL:
        "postgres://jarvis_migration_owner:pw@203.0.113.5:5432/some_other_db"
    };

    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message: string) => {
      messages.push(message);
    };

    let exitCode: number;
    try {
      exitCode = await runDevInstanceCli(["doctor"], divergentMigrationEnv);
    } finally {
      console.error = originalError;
    }

    expect(exitCode).not.toBe(0);
    expect(messages.some((message) => message.includes("refusing"))).toBe(true);
  });
});
