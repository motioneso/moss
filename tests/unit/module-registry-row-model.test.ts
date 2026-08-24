// #1187 decision 2/4: libraryAction collapses each ModuleRegistryRowDto lifecycle state to a
// single admin-actionable control (install button, enable/disable switch, or a truthful
// disabled reason) — no separate Required badge / non-actionable text row.
// describeCapabilityConsequences replaces the raw-permission-id dump with a consequence
// sentence built from structured DTO fields, while keeping the raw ids as a second sentence
// (non-goal: no weakening of install risk information).
import { describe, expect, it } from "vitest";

import type { ModuleRegistryRowDto } from "@moss/shared";

import {
  describeCapabilityConsequences,
  libraryAction
} from "../../apps/web/src/settings/settings-module-registry-section.js";

function row(overrides: Partial<ModuleRegistryRowDto> & Pick<ModuleRegistryRowDto, "id">) {
  return {
    name: overrides.id,
    description: null,
    state: "not-installed",
    installedVersion: null,
    latestVersion: null,
    stagedVersion: null,
    requiresCore: null,
    capabilities: null,
    lastInstallError: null,
    purgePending: false,
    ...overrides
  } satisfies ModuleRegistryRowDto;
}

describe("libraryAction (#1187 decision 2)", () => {
  it("absent and compatible (not-installed) -> Download and install", () => {
    expect(libraryAction(row({ id: "m", state: "not-installed" }))).toEqual({
      kind: "install",
      label: "Download and install"
    });
  });

  it("absent and compatible (declared-not-present) -> Download and install", () => {
    expect(libraryAction(row({ id: "m", state: "declared-not-present" }))).toEqual({
      kind: "install",
      label: "Download and install"
    });
  });

  it("installed and disabled, registry-known -> Enable switch", () => {
    expect(
      libraryAction(row({ id: "m", state: "installed-disabled", latestVersion: "1.0.0" }))
    ).toEqual({ kind: "switch", label: "Enable" });
  });

  it("installed and enabled, registry-known -> Disable switch", () => {
    expect(
      libraryAction(row({ id: "m", state: "installed-enabled", latestVersion: "1.0.0" }))
    ).toEqual({ kind: "switch", label: "Disable" });
  });

  it("installed-disabled but local-only (no registry-index entry) -> no switch, truthful label", () => {
    expect(
      libraryAction(row({ id: "m", state: "installed-disabled", latestVersion: null }))
    ).toEqual({ kind: "none", label: "Installed (disabled)" });
  });

  it("installed-enabled but local-only (no registry-index entry) -> no switch, truthful label", () => {
    expect(
      libraryAction(row({ id: "m", state: "installed-enabled", latestVersion: null }))
    ).toEqual({ kind: "none", label: "Installed" });
  });

  it("update-available keeps its existing truthful action, unchanged", () => {
    expect(libraryAction(row({ id: "m", state: "update-available" }))).toEqual({
      kind: "install",
      label: "Download update"
    });
  });

  it("update-pending-restart keeps its existing truthful reason, unchanged", () => {
    expect(libraryAction(row({ id: "m", state: "update-pending-restart" }))).toEqual({
      kind: "none",
      label: "Update downloaded. Restart to apply."
    });
  });

  it("pending-restart keeps its existing truthful reason, unchanged", () => {
    expect(libraryAction(row({ id: "m", state: "pending-restart" }))).toEqual({
      kind: "none",
      label: "Downloaded — restart to apply"
    });
  });

  it("install-failed keeps its existing truthful action + error reason, unchanged", () => {
    expect(
      libraryAction(
        row({ id: "m", state: "install-failed", lastInstallError: "checksum mismatch" })
      )
    ).toEqual({ kind: "install", label: "Retry download", reason: "checksum mismatch" });
  });

  it("incompatible keeps its existing truthful reason, unchanged", () => {
    expect(libraryAction(row({ id: "m", state: "incompatible", requiresCore: ">=2.0.0" }))).toEqual(
      {
        kind: "none",
        label: "Incompatible with this Moss version",
        reason: "Requires Moss >=2.0.0."
      }
    );
  });

  it("purgePending overrides state -> no action, purge reason", () => {
    expect(libraryAction(row({ id: "m", state: "installed-enabled", purgePending: true }))).toEqual(
      {
        kind: "none",
        label: "Purge pending",
        reason: "Data purge pending — takes effect on restart."
      }
    );
  });
});

describe("describeCapabilityConsequences (#1187 decision 4)", () => {
  it("leads with a consequence sentence built from structured fields, keeps raw ids as a second sentence", () => {
    const description = describeCapabilityConsequences(
      row({
        id: "m",
        capabilities: {
          permissions: ["net.fetch.acme", "tools.notes.write"],
          fetchHosts: ["api.acme.example"],
          tools: [{ name: "sendNote", risk: "write" }],
          ownsTables: ["acme_notes"]
        }
      })
    );
    // Consequence sentence first — no raw permission id before it.
    expect(description.indexOf("net.fetch.acme")).toBeGreaterThan(
      description.indexOf("connect to the internet")
    );
    expect(description).toContain("take actions that change data or send requests");
    expect(description).toContain("store its own data");
    // Raw ids preserved verbatim as a supporting detail (non-goal: no weakening of risk info).
    expect(description).toContain("net.fetch.acme");
    expect(description).toContain("tools.notes.write");
  });

  it("read-only tools do not count as side-effecting", () => {
    const description = describeCapabilityConsequences(
      row({
        id: "m",
        capabilities: {
          permissions: ["notes.read"],
          fetchHosts: [],
          tools: [{ name: "listNotes", risk: "read" }],
          ownsTables: []
        }
      })
    );
    expect(description).not.toContain("take actions that change data or send requests");
  });

  it("no capabilities at all -> plain no-connection/no-data sentence", () => {
    const description = describeCapabilityConsequences(
      row({
        id: "m",
        capabilities: { permissions: [], fetchHosts: [], tools: [], ownsTables: [] }
      })
    );
    expect(description).toContain("makes no outside connections and stores no data");
  });

  it("null capabilities (local-only row) -> existing not-yet-available copy, unchanged", () => {
    expect(describeCapabilityConsequences(row({ id: "m", capabilities: null }))).toBe(
      "No capability information is available yet. The download applies on the next restart."
    );
  });
});
