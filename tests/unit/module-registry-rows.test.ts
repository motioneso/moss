// Task 6 (#964): lifecycle-state derivation for the admin module-registry surface.
// Pure function — every spec §8 state gets a case, plus the precedence rules
// (staged beats install-error; update-available requires enabled).
import { describe, expect, it } from "vitest";

import {
  deriveModuleRegistryRows,
  type ModuleRegistryDeriveInput
} from "../../packages/settings/src/module-registry-rows.js";

const indexEntry = {
  id: "demo-module",
  name: "Job search",
  description: "Job listings watcher",
  version: "0.2.0",
  requiresCore: ">=0.1.0",
  capabilities: {
    permissions: ["demo-module.read"],
    fetchHosts: ["api.example.com"],
    tools: [{ name: "job_search_query", risk: "low" }],
    ownsTables: ["app.job_search_listings"]
  }
} as const;

const adminState = {
  id: "demo-module",
  status: "enabled" as const,
  packageHash: "sha256:aaaa",
  disabledReason: null,
  ownerUserId: null,
  stagedVersion: null,
  stagedPackageHash: null,
  stagedSource: null,
  purgeRequestedAt: null,
  lastInstallError: null
};

const discovery = {
  id: "demo-module",
  name: "Job search",
  version: "0.1.0",
  description: "Job listings watcher"
};

function derive(overrides: Partial<ModuleRegistryDeriveInput>) {
  const input: ModuleRegistryDeriveInput = {
    registryEntries: [indexEntry],
    discoveries: [],
    rejected: [],
    adminStates: [],
    onDiskIds: [],
    ensureIds: [],
    ...overrides
  };
  return deriveModuleRegistryRows(input);
}

describe("deriveModuleRegistryRows", () => {
  it("in index, nothing local → not-installed with capabilities", () => {
    const rows = derive({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "demo-module",
      state: "not-installed",
      latestVersion: "0.2.0",
      installedVersion: null,
      capabilities: indexEntry.capabilities,
      purgePending: false
    });
  });

  it("incompatible index entry → incompatible with requiresCore surfaced", () => {
    const rows = derive({
      registryEntries: [{ ...indexEntry, requiresCore: ">=99.0.0" }]
    });
    expect(rows[0]!.state).toBe("incompatible");
    expect(rows[0]!.requiresCore).toBe(">=99.0.0");
  });

  it("staged + not in boot discovery → pending-restart", () => {
    const rows = derive({
      onDiskIds: ["demo-module"],
      adminStates: [
        {
          ...adminState,
          status: "disabled",
          stagedVersion: "0.2.0",
          stagedPackageHash: "sha256:bbbb"
        }
      ]
    });
    expect(rows[0]!.state).toBe("pending-restart");
    expect(rows[0]!.stagedVersion).toBe("0.2.0");
  });

  it("staged + present in boot discovery → update-pending-restart", () => {
    const rows = derive({
      discoveries: [discovery],
      onDiskIds: ["demo-module"],
      adminStates: [{ ...adminState, stagedVersion: "0.2.0", stagedPackageHash: "sha256:bbbb" }]
    });
    expect(rows[0]!.state).toBe("update-pending-restart");
    expect(rows[0]!.installedVersion).toBe("0.1.0");
  });

  it("staged wins over a stale lastInstallError (retry re-downloaded)", () => {
    const rows = derive({
      onDiskIds: ["demo-module"],
      adminStates: [
        {
          ...adminState,
          status: "disabled",
          stagedVersion: "0.2.0",
          stagedPackageHash: "sha256:bbbb",
          lastInstallError: "boom"
        }
      ]
    });
    expect(rows[0]!.state).toBe("pending-restart");
  });

  it("lastInstallError without staged → install-failed", () => {
    const rows = derive({
      onDiskIds: ["demo-module"],
      adminStates: [
        { ...adminState, status: "disabled", lastInstallError: "migration 0001 failed" }
      ]
    });
    expect(rows[0]!.state).toBe("install-failed");
    expect(rows[0]!.lastInstallError).toBe("migration 0001 failed");
  });

  it("boot-rejected package → install-failed with the rejection reason", () => {
    const rows = derive({
      onDiskIds: ["demo-module"],
      rejected: [{ id: "demo-module", reason: "manifest id mismatch" }]
    });
    expect(rows[0]!.state).toBe("install-failed");
    expect(rows[0]!.lastInstallError).toBe("manifest id mismatch");
  });

  it("enabled on disk, index newer → update-available", () => {
    const rows = derive({
      discoveries: [discovery],
      onDiskIds: ["demo-module"],
      adminStates: [adminState]
    });
    expect(rows[0]!.state).toBe("update-available");
    expect(rows[0]!.installedVersion).toBe("0.1.0");
    expect(rows[0]!.latestVersion).toBe("0.2.0");
  });

  it("enabled on disk, index same version → installed-enabled", () => {
    const rows = derive({
      registryEntries: [{ ...indexEntry, version: "0.1.0" }],
      discoveries: [discovery],
      onDiskIds: ["demo-module"],
      adminStates: [adminState]
    });
    expect(rows[0]!.state).toBe("installed-enabled");
  });

  it("disabled on disk → installed-disabled even when the index is newer", () => {
    const rows = derive({
      discoveries: [discovery],
      onDiskIds: ["demo-module"],
      adminStates: [{ ...adminState, status: "disabled", disabledReason: "disabled by admin" }]
    });
    expect(rows[0]!.state).toBe("installed-disabled");
    expect(rows[0]!.latestVersion).toBe("0.2.0");
  });

  it("ensure-declared, missing from disk and index fetch → declared-not-present", () => {
    const rows = derive({ registryEntries: [], ensureIds: ["demo-module"] });
    expect(rows[0]!.state).toBe("declared-not-present");
  });

  it("purge pending after remove: dir gone, DB row remains → not-installed + purgePending", () => {
    const rows = derive({
      adminStates: [
        {
          ...adminState,
          status: "disabled",
          purgeRequestedAt: new Date("2026-07-12T00:00:00.000Z")
        }
      ]
    });
    expect(rows[0]!.state).toBe("not-installed");
    expect(rows[0]!.purgePending).toBe(true);
  });

  it("registryEntries null (registry unavailable) → local rows only, no index fields", () => {
    const rows = deriveModuleRegistryRows({
      registryEntries: null,
      discoveries: [discovery],
      rejected: [],
      adminStates: [adminState],
      onDiskIds: ["demo-module"],
      ensureIds: []
    });
    expect(rows[0]!.state).toBe("installed-enabled");
    expect(rows[0]!.latestVersion).toBeNull();
    expect(rows[0]!.capabilities).toBeNull();
  });

  it("sorts rows by id", () => {
    const rows = derive({
      registryEntries: [{ ...indexEntry, id: "zeta", name: "Zeta" }, indexEntry]
    });
    expect(rows.map((r) => r.id)).toEqual(["demo-module", "zeta"]);
  });
});
