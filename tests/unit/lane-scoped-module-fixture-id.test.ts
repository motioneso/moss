import { describe, expect, it } from "vitest";

import { moduleInstallRoleName, moduleRuntimeRoleName } from "../../packages/db/src/module-role-broker.js";
import { laneScopedModuleId } from "../integration/test-database.js";

const LANE_A = "postgres://user:pw@localhost:5432/jarvis_test_lane_a";
const LANE_B = "postgres://user:pw@localhost:5432/jarvis_test_lane_b";

describe("laneScopedModuleId (#1625)", () => {
  it("derives different ids for different lane database identities from the same base name", () => {
    const idA = laneScopedModuleId("acme-widgets", LANE_A);
    const idB = laneScopedModuleId("acme-widgets", LANE_B);
    expect(idA).not.toBe(idB);
    expect(moduleRuntimeRoleName(idA)).not.toBe(moduleRuntimeRoleName(idB));
    expect(moduleInstallRoleName(idA)).not.toBe(moduleInstallRoleName(idB));
  });

  it("is deterministic for the same lane and base name", () => {
    expect(laneScopedModuleId("acme-widgets", LANE_A)).toBe(laneScopedModuleId("acme-widgets", LANE_A));
  });

  it("keeps every generated role name within Postgres's 63-byte identifier limit even for a long base name", () => {
    const longBase = "a-very-long-throwaway-fixture-module-name-that-is-unusually-verbose";
    const id = laneScopedModuleId(longBase, LANE_A);
    expect(moduleRuntimeRoleName(id).length).toBeLessThanOrEqual(63);
    expect(moduleInstallRoleName(id).length).toBeLessThanOrEqual(63);
  });

  it("does not collide when two long base names share the same 44-char prefix", () => {
    const prefix = "a".repeat(44);
    const idOne = laneScopedModuleId(`${prefix}-one`, LANE_A);
    const idTwo = laneScopedModuleId(`${prefix}-two`, LANE_A);
    expect(idOne).not.toBe(idTwo);
    expect(moduleRuntimeRoleName(idOne).length).toBeLessThanOrEqual(63);
    expect(moduleRuntimeRoleName(idTwo).length).toBeLessThanOrEqual(63);
  });
});
