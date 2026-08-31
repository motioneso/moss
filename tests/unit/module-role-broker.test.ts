import { afterEach, describe, expect, it, vi } from "vitest";

import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";

describe("module role name derivation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds the runtime role name, replacing hyphens with underscores", () => {
    expect(moduleRuntimeRoleName("acme-widgets")).toBe("jarvis_mod_acme_widgets_runtime");
  });

  it("builds the install role name", () => {
    expect(moduleInstallRoleName("acme-widgets")).toBe("jarvis_mod_acme_widgets_install");
  });

  it("scopes both roles to the lane without changing the real module id", () => {
    expect(moduleRuntimeRoleName("job-search", "jarvis_gate_lane_a")).toBe(
      "jarvis_mod_job_search_7d8fbb7f_runtime"
    );
    expect(moduleInstallRoleName("job-search", "jarvis_gate_lane_a")).toBe(
      "jarvis_mod_job_search_7d8fbb7f_install"
    );
  });

  it("gives two lanes distinct deterministic roles for the same real module", () => {
    expect(moduleRuntimeRoleName("job-search", "jarvis_gate_lane_a")).not.toBe(
      moduleRuntimeRoleName("job-search", "jarvis_gate_lane_b")
    );
    expect(moduleInstallRoleName("job-search", "jarvis_gate_lane_a")).not.toBe(
      moduleInstallRoleName("job-search", "jarvis_gate_lane_b")
    );
    expect(moduleRuntimeRoleName("job-search", "jarvis_gate_lane_b")).toBe(
      "jarvis_mod_job_search_1089be04_runtime"
    );
  });

  it("uses the guarded runner's test scope when no explicit scope is passed", () => {
    vi.stubEnv("JARVIS_TEST_MODULE_ROLE_SCOPE", "jarvis_gate_lane_a");

    expect(moduleRuntimeRoleName("job-search")).toBe("jarvis_mod_job_search_7d8fbb7f_runtime");
    expect(moduleInstallRoleName("job-search")).toBe("jarvis_mod_job_search_7d8fbb7f_install");
  });

  it("keeps long same-prefix module ids distinct and within PostgreSQL's identifier limit", () => {
    const prefix = "a".repeat(40);
    const runtimeOne = moduleRuntimeRoleName(`${prefix}-one`, "jarvis_gate_lane_a");
    const runtimeTwo = moduleRuntimeRoleName(`${prefix}-two`, "jarvis_gate_lane_a");

    expect(runtimeOne).not.toBe(runtimeTwo);
    expect(runtimeOne.length).toBeLessThanOrEqual(63);
    expect(runtimeTwo.length).toBeLessThanOrEqual(63);
    expect(moduleInstallRoleName(`${prefix}-one`, "jarvis_gate_lane_a").length).toBeLessThanOrEqual(
      63
    );
  });

  it("rejects a module id that is not a valid kebab slug", () => {
    expect(() => moduleRuntimeRoleName("Acme Widgets")).toThrow(/invalid module id/i);
  });
});
