// External-module and module-distribution dependency types for the settings routes.
//
// Extracted from ./routes.ts for the 1000-line file-size gate, the same way the module-management
// route handlers were in #917. Types only — no runtime code — and routes.ts re-exports every name
// here, so existing importers are unaffected.
import type { ExternalModuleDto } from "@moss/shared";
import type { JsonMossModuleManifest } from "@moss/module-sdk";

import type { ModuleRegistryEntryLike } from "./module-registry-rows.js";
import type { ExternalModuleState } from "./repository.js";

// #917 — LOCAL mirrors of @moss/module-registry's external-module types. Settings does
// NOT (and must not) depend on @moss/module-registry — that package already depends on
// @moss/settings, so importing back would create a dependency cycle and violate module
// isolation. These are structurally identical to the registry's ExternalModuleDiscovery /
// ExternalModuleRejection; the composition root (apps/api) passes the REAL registry values
// in and TypeScript's structural typing accepts them. Keep in sync with
// packages/module-registry/src/external/types.ts if that shape ever changes.
export interface ExternalModuleDiscovery {
  readonly id: string;
  readonly dir: string;
  readonly manifest: JsonMossModuleManifest;
  readonly manifestHash: string;
  readonly packageHash: string;
}

export interface ExternalModuleRejection {
  readonly id: string;
  readonly reason: string;
}

/**
 * #1762 — the slice of an installed external module the personal Modules list needs. Structurally
 * a subset of module-registry's ReconciledExternalModule, restated here for the same
 * no-import-cycle reason as the mirrors above.
 */
export interface InstalledExternalModuleSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly hasPreferences: boolean;
  /**
   * #1759: the module declares credential slots the user fills themselves. Separate from
   * hasPreferences because a module can have one and not the other — Finance declares user
   * credentials and no switches — and either one on its own is a reason to offer a settings page.
   */
  readonly hasUserCredentials: boolean;
}

/**
 * Boot-time external-module discovery snapshot (#917), injected by the composition root.
 * The admin GET route (Task 9) reconciles `discoveries` against app.external_modules;
 * `rejected` is surfaced read-only so admins can see why a mounted dir did not load.
 * Absent / `enabled: false` ⇒ the external-module admin surface reports the feature off.
 */
export interface ExternalModulesDependencies {
  readonly enabled: boolean;
  readonly discoveries: readonly ExternalModuleDiscovery[];
  readonly rejected: readonly ExternalModuleRejection[];
  /**
   * #917 — reconcile port injected by the composition root (apps/api). Settings CANNOT import
   * @moss/module-registry (reconcileExternalModules lives there; that package already depends
   * on @moss/settings, so a direct import cycles + breaks module isolation — same discipline as
   * reconcileNotesSchedule). apps/api closes this over the boot discovery snapshot, so callers pass
   * only the persisted states. `modules` are already reconciled + DTO-shaped, drift-inactive already
   * applied; `driftDisable` is the to-persist auto-disable list (the GET route writes it back).
   * reason is DRIFT_DISABLED_REASON, baked in by reconcile — settings never needs that constant.
   *
   * #1762 note: ReconciledExternalModule is NOT field-identical to ExternalModuleDto any more — it
   * also carries the module's declared preferences and navigation, which this port's return type
   * erases. That is why the personal Modules list gets its own narrower port
   * (`listInstalledExternalModules`) rather than reading anything back out of here.
   */
  readonly reconcile: (states: readonly ExternalModuleState[]) => {
    readonly modules: readonly ExternalModuleDto[];
    readonly driftDisable: readonly { readonly id: string; readonly reason: string }[];
  };
}

/**
 * #964 — module-distribution port injected by the composition root. Network + filesystem
 * only; all DB writes stay in this package (updateExternalModuleStaging etc.), so the
 * pipeline never needs a database handle and settings never imports module-registry.
 */
export interface ModuleDistributionDependencies {
  /**
   * Pinned-registry index entries, served through the composition root's 10-minute
   * in-process cache; `refresh: true` busts it. null = registry unreachable/invalid —
   * the GET degrades to local-only rows, never a 500 (spec §6).
   */
  readonly fetchRegistryEntries: (options: {
    readonly refresh: boolean;
  }) => Promise<readonly ModuleRegistryEntryLike[] | null>;
  /** Run download→verify→extract→stage (Task 5 pipeline). Never touches the DB. */
  readonly download: (input: {
    readonly moduleId: string;
    readonly version?: string;
  }) => Promise<
    | { readonly ok: true; readonly version: string; readonly packageHash: string }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  /** Delete JARVIS_MODULES_DIR/<id>. Idempotent; missing dir is fine. */
  readonly removeModuleFiles: (moduleId: string) => Promise<void>;
  /** LIVE readdir of JARVIS_MODULES_DIR (module dirs only, no dot-dirs). */
  readonly listOnDiskModuleIds: () => Promise<readonly string[]>;
  /** Ids declared in JARVIS_MODULES_ENSURE (for declared-not-present rows). */
  readonly ensureIds: readonly string[];
}
