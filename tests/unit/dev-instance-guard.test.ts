import { describe, expect, it } from "vitest";

import {
  assertDevEnvParity,
  assertTargetIsDevInstance,
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
});
