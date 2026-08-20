import { describe, expect, it } from "vitest";

import {
  assertDevEnvParity,
  assertTargetIsDevInstance,
  DevEnvParityError,
  NotDevInstanceError
} from "../../scripts/dev-instance/guard.js";

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
