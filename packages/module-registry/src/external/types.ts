// Node-free shared types for external module discovery (#917). Kept out of node.ts so
// the browser entry (index.ts) and the pure reconcile step can import them too.
import type {
  ExternalModuleNavigationEntry,
  ExternalModulePreferenceDeclaration,
  JsonMossModuleManifest
} from "@moss/module-sdk";

/** A validated, on-disk external module: its metadata-only manifest + content hashes. */
export interface ExternalModuleDiscovery {
  readonly id: string;
  readonly dir: string;
  readonly manifest: JsonMossModuleManifest;
  readonly manifestHash: string;
  readonly packageHash: string;
}

/** A directory under the modules root that was NOT loaded, with a human-readable reason. */
export interface ExternalModuleRejection {
  readonly id: string;
  readonly reason: string;
}

export interface ExternalModuleLoadResult {
  readonly discoveries: readonly ExternalModuleDiscovery[];
  readonly rejected: readonly ExternalModuleRejection[];
}

/** One persisted app.external_modules row, narrowed to what reconcile needs (#917). */
export interface ExternalModuleStateInput {
  readonly id: string;
  readonly status: "enabled" | "disabled" | "draft";
  readonly packageHash: string | null;
  readonly disabledReason: string | null;
  readonly ownerUserId: string | null;
}

/** 'discovered' is virtual — it means "on disk, no DB row". Only enabled/disabled/draft persist. */
export type ExternalModuleStatus = "discovered" | "enabled" | "disabled" | "draft";

export interface ReconciledExternalModule {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly status: ExternalModuleStatus;
  readonly active: boolean;
  readonly drifted: boolean;
  readonly disabledReason: string | null;
  readonly ownerUserId: string | null;
  /** Web contribution declared by the manifest, or null when the module has no web surface (#918). */
  readonly web: { readonly entrypoint: string; readonly contractVersion: number } | null;
  // #1019: nav-menu entries this module contributes; always present, defaults to [] for a
  // metadata-only module. apps/api/src/server.ts serializeExternalModule maps + prefixes
  // these into the wire-shape ModuleNavigationEntryDto.
  readonly navigation: readonly ExternalModuleNavigationEntry[];
  // #1725: on/off switches this module offers; always present, [] when it declares none.
  // The host owns both the rendering and the storage — see the preferences routes in
  // apps/api/src/routes/module-preferences.ts.
  readonly preferences: readonly ExternalModulePreferenceDeclaration[];
}

export interface ExternalReconcileResult {
  readonly modules: ReconciledExternalModule[];
  readonly driftDisable: Array<{ id: string; reason: string }>;
}
