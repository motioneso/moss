import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetMossEnvWarningsForTest, isCarvedOutMossEnvName, resolveMossEnv } from "../env.js";

describe("resolveMossEnv", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMossEnvWarningsForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("falls back to the legacy JARVIS_ name when the MOSS_ name is unset, warning exactly once", () => {
    const env = { JARVIS_VAULT_ROOT: "/data/vaults" };

    expect(resolveMossEnv(env, "JARVIS_VAULT_ROOT")).toBe("/data/vaults");
    expect(resolveMossEnv(env, "JARVIS_VAULT_ROOT")).toBe("/data/vaults");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("JARVIS_VAULT_ROOT");
    expect(warnSpy.mock.calls[0]?.[0]).toContain("MOSS_VAULT_ROOT");
  });

  it("prefers the new MOSS_ name when both are set, and never warns", () => {
    const env = { JARVIS_VAULT_ROOT: "/data/old-vaults", MOSS_VAULT_ROOT: "/data/new-vaults" };

    expect(resolveMossEnv(env, "JARVIS_VAULT_ROOT")).toBe("/data/new-vaults");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns undefined and never warns when neither name is set", () => {
    expect(resolveMossEnv({}, "JARVIS_VAULT_ROOT")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns once per distinct variable, independently", () => {
    const env = { JARVIS_VAULT_ROOT: "/data/vaults", JARVIS_APP_VERSION: "1.2.3" };

    resolveMossEnv(env, "JARVIS_VAULT_ROOT");
    resolveMossEnv(env, "JARVIS_APP_VERSION");
    resolveMossEnv(env, "JARVIS_VAULT_ROOT");
    resolveMossEnv(env, "JARVIS_APP_VERSION");

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("passes a carved-out name straight through with no MOSS_ lookup and no warning", () => {
    const env = {
      JARVIS_CLI_RUNNER_SOCKET: "/run/jarv1s/cli-runner.sock",
      MOSS_CLI_RUNNER_SOCKET: "/should/not/be/read"
    };

    expect(isCarvedOutMossEnvName("JARVIS_CLI_RUNNER_SOCKET")).toBe(true);
    expect(resolveMossEnv(env, "JARVIS_CLI_RUNNER_SOCKET")).toBe("/run/jarv1s/cli-runner.sock");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("carves out the TLS setup names read host-side by compose and the Caddyfile", () => {
    const env = { JARVIS_TLS_HOST: "moss.lan", MOSS_TLS_HOST: "should-not-be-read" };

    expect(isCarvedOutMossEnvName("JARVIS_TLS_HOST")).toBe(true);
    expect(isCarvedOutMossEnvName("JARVIS_TLS_ISSUER")).toBe(true);
    expect(resolveMossEnv(env, "JARVIS_TLS_HOST")).toBe("moss.lan");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("passes a non-JARVIS_ name straight through unchanged", () => {
    const env = { DATABASE_URL: "postgres://x" };

    expect(resolveMossEnv(env, "DATABASE_URL")).toBe("postgres://x");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
