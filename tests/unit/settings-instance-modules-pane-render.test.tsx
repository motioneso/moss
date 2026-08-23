// #1084: renders the REAL component tree (InstanceModulesPane -> filterUndeclaredExternalModules
// -> ModuleCredentialsSection), not just the pure derivation functions covered by
// instance-modules-dedup.test.tsx — this is what actually regressed for an operator: the
// External-modules group (trust warning + #918 admin credentials) went permanently empty for
// every discovered module because registryIds was built from ALL registry rows instead of only
// index-backed ones (see settings-instance-modules-pane.tsx's registryIndexIds comment). Uses the
// same renderToString + pre-seeded QueryClient pattern as settings-admin-panes.test.tsx — no
// network mocking needed since every query this pane fires is pre-populated via setQueryData.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  ExternalModuleDto,
  GetModuleRegistryResponse,
  ListModuleCredentialsResponse,
  ListModulesResponse,
  ModuleRegistryRowDto
} from "@moss/shared";

import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { InstanceModulesPane } from "../../apps/web/src/settings/settings-instance-modules-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import { describeCapabilityConsequences } from "../../apps/web/src/settings/settings-module-registry-section.js";

function renderWithQuery(client: QueryClient): string {
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(FeedbackProvider, null, createElement(InstanceModulesPane))
    )
  );
}

// A module discovered on disk (boot-time load succeeded) that was never published to the
// registry index — the exact #1084 scenario ("operator drops a self-authored, never-published
// module in the modules dir").
const UNDECLARED_ID = "acme-undeclared";
// A module that IS registry-known (e.g. downloaded via the registry) — must NOT duplicate into
// the External-modules group; this is the case filterUndeclaredExternalModules is SUPPOSED to
// drop, so the test also proves the fix didn't just delete the filter entirely.
const DECLARED_ID = "acme-declared";

function seedClient(
  declaredState:
    | "installed-enabled"
    | "installed-disabled"
    | "update-available"
    | "update-pending-restart" = "installed-enabled"
): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.settings.adminModules, {
    modules: []
  } satisfies ListModulesResponse);
  client.setQueryData(queryKeys.settings.adminExternalModules, {
    enabled: true,
    modules: [
      {
        id: UNDECLARED_ID,
        name: "Acme Undeclared",
        version: "0.1.0",
        publisher: "Acme",
        status: "disabled",
        active: false,
        drifted: false,
        disabledReason: null,
        web: null
      },
      {
        id: DECLARED_ID,
        name: "Acme Declared",
        version: "0.1.0",
        publisher: "Acme",
        status: "enabled",
        active: true,
        drifted: false,
        disabledReason: null,
        web: null
      }
    ] satisfies readonly ExternalModuleDto[]
  });
  client.setQueryData(queryKeys.settings.adminModuleRegistry, {
    enabled: true,
    registryUnavailable: false,
    modules: [
      {
        id: UNDECLARED_ID,
        name: "Acme Undeclared",
        description: null,
        state: "installed-disabled",
        installedVersion: "0.1.0",
        // Local-only row: no registry-index entry backs it (module-registry-rows.ts leaves
        // latestVersion null for exactly this case) — the field registryIndexIds keys on.
        latestVersion: null,
        stagedVersion: null,
        requiresCore: null,
        capabilities: null,
        lastInstallError: null,
        purgePending: false
      },
      {
        id: DECLARED_ID,
        name: "Acme Declared",
        description: null,
        state: declaredState,
        installedVersion: "0.1.0",
        // Backed by a registry-index entry -> registry-known -> must be excluded from the
        // External-modules group below (it already has its own row in Available modules).
        latestVersion: "0.1.0",
        stagedVersion: null,
        requiresCore: null,
        capabilities: null,
        lastInstallError: null,
        purgePending: false
      }
    ]
  } satisfies GetModuleRegistryResponse);
  // ModuleCredentialsSection's query key is a literal tuple (module-credentials-section.tsx),
  // not part of queryKeys — mirrored here rather than importing an internal constant.
  client.setQueryData(["module-credentials", "admin", UNDECLARED_ID], {
    moduleId: UNDECLARED_ID,
    credentials: [
      {
        credentialId: `${UNDECLARED_ID}.api-key`,
        displayName: "Acme API Key",
        scope: "instance",
        configured: false,
        updatedAt: null
      }
    ]
  } satisfies ListModuleCredentialsResponse);
  client.setQueryData(["module-credentials", "admin", DECLARED_ID], {
    moduleId: DECLARED_ID,
    credentials: [
      {
        credentialId: `${DECLARED_ID}.api-key`,
        displayName: "Declared API Key",
        scope: "instance",
        configured: false,
        updatedAt: null
      }
    ]
  } satisfies ListModuleCredentialsResponse);
  return client;
}

describe("InstanceModulesPane external-modules group (#1084)", () => {
  it("shows the trusted-operator warning for a discovered-but-unpublished module", () => {
    const html = renderWithQuery(seedClient());
    expect(html).toContain("External modules are not reviewed by Moss");
    expect(html).toContain("Acme Undeclared");
  });

  it("renders the #918 admin credentials section for that module (not silently dropped)", () => {
    const html = renderWithQuery(seedClient());
    const occurrences = html.split("Acme API Key").length - 1;
    expect(occurrences).toBe(2); // Field label + input aria-label, exactly one field.
  });

  it.each([
    "installed-enabled",
    "installed-disabled",
    "update-available",
    "update-pending-restart"
  ] as const)(
    "renders admin credentials for a registry-installed module in %s (#1176)",
    (state) => {
      const html = renderWithQuery(seedClient(state));
      expect(html).toContain("Declared API Key");
    }
  );

  // #1042: the in-app restart instruction must not tell the operator to run a no-op
  // (`docker compose pull && docker compose up -d` is a documented Compose no-op when the
  // image tag hasn't changed — see tests/uat/provisioner.ts:732 — so a downloaded module
  // never actually applies). It must name a command that really restarts the container.
  it("tells the operator to restart, not to run the no-op pull+up instruction (#1042)", () => {
    const html = renderWithQuery(seedClient("update-pending-restart"));
    expect(html).toContain("docker compose restart jarv1s");
    expect(html).not.toContain("docker compose pull");
    expect(html).not.toContain("docker compose up -d");
  });

  it("does not duplicate a registry-known module into the External-modules group", () => {
    const html = renderWithQuery(seedClient());
    // DECLARED_ID is registry-known (latestVersion set) — filterUndeclaredExternalModules
    // must drop it from this group, so its name/version line appears exactly once (from
    // ModuleRegistrySection's "Available modules" list), not a second time here. Matching on
    // the Row's version-line text (not just the name) targets the actual rendered row rather
    // than an incidental second mention of "Acme Declared" elsewhere on the pane.
    const versionLineOccurrences = html.split("Acme · v0.1.0").length - 1;
    expect(versionLineOccurrences).toBeLessThanOrEqual(1);
    // The genuinely-undeclared module still renders its own Row in this group — proves the
    // filter didn't just start dropping everything.
    expect(html).toContain("Acme Undeclared");
  });
});

// #1187 decision 5: the trust warning must appear only when the inventory actually contains a
// module from a source outside the pinned registry — not merely because `external.enabled`.
describe("InstanceModulesPane external-modules trust warning (#1187 decision 5)", () => {
  function seedNoUndeclaredExternal(): QueryClient {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.adminModules, {
      modules: []
    } satisfies ListModulesResponse);
    client.setQueryData(queryKeys.settings.adminExternalModules, {
      enabled: true,
      modules: [
        {
          id: DECLARED_ID,
          name: "Acme Declared",
          version: "0.1.0",
          publisher: "Acme",
          status: "enabled",
          active: true,
          drifted: false,
          disabledReason: null,
          web: null
        }
      ] satisfies readonly ExternalModuleDto[]
    });
    client.setQueryData(queryKeys.settings.adminModuleRegistry, {
      enabled: true,
      registryUnavailable: false,
      modules: [
        {
          id: DECLARED_ID,
          name: "Acme Declared",
          description: null,
          state: "installed-enabled",
          installedVersion: "0.1.0",
          // Registry-index-backed -> registryIndexIds includes it -> not undeclared.
          latestVersion: "0.1.0",
          stagedVersion: null,
          requiresCore: null,
          capabilities: null,
          lastInstallError: null,
          purgePending: false
        }
      ]
    } satisfies GetModuleRegistryResponse);
    client.setQueryData(["module-credentials", "admin", DECLARED_ID], {
      moduleId: DECLARED_ID,
      credentials: []
    } satisfies ListModuleCredentialsResponse);
    return client;
  }

  it("hides the External modules group entirely when no module is actually undeclared", () => {
    const html = renderWithQuery(seedNoUndeclaredExternal());
    expect(html).not.toContain("External modules are not reviewed by Moss");
    expect(html).not.toContain("External modules");
  });

  it("still shows the warning when an undeclared module is present (existing behavior)", () => {
    const html = renderWithQuery(seedClient());
    expect(html).toContain("External modules are not reviewed by Moss");
  });
});

// #1187 decisions 1/2: built-in optional modules and downloadable registry modules render as
// ONE actionable inventory ("Module library"), not a separate "Optional modules" +
// "Available modules" section pair.
describe("InstanceModulesPane module library merge (#1187 decisions 1/2)", () => {
  function seedMergeClient(): QueryClient {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.settings.adminModules, {
      modules: [
        {
          id: "builtin-a",
          name: "Builtin A",
          version: "1.0.0",
          lifecycle: "optional",
          navigation: [],
          settings: []
        }
      ]
    } satisfies ListModulesResponse);
    client.setQueryData(queryKeys.settings.adminModuleRegistry, {
      enabled: true,
      registryUnavailable: false,
      modules: [
        {
          id: "registry-a",
          name: "Registry A",
          description: null,
          state: "not-installed",
          installedVersion: null,
          latestVersion: "1.0.0",
          stagedVersion: null,
          requiresCore: null,
          capabilities: null,
          lastInstallError: null,
          purgePending: false
        }
      ]
    } satisfies GetModuleRegistryResponse);
    return client;
  }

  it("renders one merged 'Module library' group, not separate 'Optional modules'/'Available modules' sections", () => {
    const html = renderWithQuery(seedMergeClient());
    expect(html).toContain("Module library");
    expect(html).not.toContain("Optional modules");
    expect(html).not.toContain("Available modules");
    expect(html).not.toContain('aria-label="Module registry"');
  });

  it("places a registry row inside the merged Module library group, after the built-in row", () => {
    const html = renderWithQuery(seedMergeClient());
    const groupIndex = html.indexOf("Module library");
    const builtinIndex = html.indexOf("Builtin A");
    const registryIndex = html.indexOf("Registry A");
    expect(groupIndex).toBeGreaterThan(-1);
    expect(builtinIndex).toBeGreaterThan(groupIndex);
    expect(registryIndex).toBeGreaterThan(builtinIndex);
  });

  it("uses decision-2 wording 'Download and install' instead of 'Install'", () => {
    const html = renderWithQuery(seedMergeClient());
    expect(html).toContain("Download and install");
    expect(html).not.toContain(">Install<");
  });
});

// QA-RED remediation (2026-07-20): describeCapabilityConsequences was only unit-tested as a
// pure function against `capabilities: null` fixtures — the actual install-confirm dialog
// markup never proved it renders the consequence sentence for a row with real capabilities.
// FeedbackProvider's `initialDialog` seed (settings-feedback.tsx) exists specifically to close
// this gap without jsdom/@testing-library (repo has neither).
function capabilityRow(
  overrides: Partial<ModuleRegistryRowDto> & Pick<ModuleRegistryRowDto, "id">
): ModuleRegistryRowDto {
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

describe("install-confirm dialog capability copy (#1187 decision 4 render proof)", () => {
  it("renders the consequence sentence in .jds-dialog__desc for a row with real capabilities", () => {
    const rowWithCaps = capabilityRow({
      id: "acme-net",
      capabilities: {
        permissions: ["net.fetch.acme"],
        fetchHosts: ["api.acme.example"],
        tools: [],
        ownsTables: []
      }
    });
    const html = renderToString(
      createElement(FeedbackProvider, {
        initialDialog: {
          title: "Install Acme Net?",
          description: describeCapabilityConsequences(rowWithCaps),
          confirmLabel: "Download",
          onConfirm: () => {}
        },
        children: createElement("div")
      })
    );
    expect(html).toContain("jds-dialog__desc");
    expect(html).toContain("This module can connect to the internet");
  });
});
