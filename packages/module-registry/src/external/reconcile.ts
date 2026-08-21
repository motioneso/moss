// Pure fail-closed reconciliation of on-disk discoveries against persisted enablement
// rows (#917). No I/O, no node:* — safe to import from the browser bundle and from the
// admin route. Activation truth table lives here; the loader and repository are dumb.
import type {
  ExternalModuleDiscovery,
  ExternalModuleStateInput,
  ExternalReconcileResult,
  ReconciledExternalModule
} from "./types.js";

/** Written to disabled_reason when an enabled module's package hash drifts (#917). */
export const DRIFT_DISABLED_REASON = "package changed since it was enabled";

export function reconcileExternalModules(
  discoveries: readonly ExternalModuleDiscovery[],
  rows: readonly ExternalModuleStateInput[]
): ExternalReconcileResult {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const modules: ReconciledExternalModule[] = [];
  const driftDisable: Array<{ id: string; reason: string }> = [];

  for (const discovery of discoveries) {
    const { id, manifest, packageHash } = discovery;
    const base = {
      id,
      name: manifest.name,
      version: manifest.version,
      publisher: manifest.publisher,
      web: manifest.web ?? null,
      // #1019: default to [] so every reconciled module has a navigation array — downstream
      // code (serializeExternalModule, buildShellNavigation) never needs an undefined check.
      navigation: manifest.navigation ?? [],
      // #1725: same default-to-[] reasoning as navigation above — the preferences route
      // and the settings pane can then treat "declares none" and "declares an empty list"
      // identically without an undefined check.
      preferences: manifest.preferences ?? []
    };
    const row = rowsById.get(id);

    // No row → virtual 'discovered'. Fail-closed: inactive until an admin enables it.
    if (!row) {
      modules.push({
        ...base,
        status: "discovered",
        active: false,
        drifted: false,
        disabledReason: null,
        ownerUserId: null
      });
      continue;
    }

    // Explicitly disabled → stay disabled, carry the admin's reason.
    if (row.status === "disabled") {
      modules.push({
        ...base,
        status: "disabled",
        active: false,
        drifted: false,
        disabledReason: row.disabledReason,
        ownerUserId: null
      });
      continue;
    }

    // Draft → always active for its author, exempt from drift detection. Drafts are edited
    // live by their author, so a changed package hash is expected, not a signal to disable.
    // Only shipping (Task 10) ends this exemption, by moving status to 'enabled'.
    if (row.status === "draft") {
      modules.push({
        ...base,
        status: "draft",
        active: true,
        drifted: false,
        disabledReason: null,
        ownerUserId: row.ownerUserId
      });
      continue;
    }

    // Enabled + hash still matches → active.
    if (row.packageHash === packageHash) {
      modules.push({
        ...base,
        status: "enabled",
        active: true,
        drifted: false,
        disabledReason: null,
        ownerUserId: null
      });
      continue;
    }

    // Enabled but the package changed since enable → DRIFT. Fail closed (inactive) and
    // record the id so the admin GET path can persist the auto-disable under admin RLS.
    modules.push({
      ...base,
      status: "disabled",
      active: false,
      drifted: true,
      disabledReason: DRIFT_DISABLED_REASON,
      ownerUserId: null
    });
    driftDisable.push({ id, reason: DRIFT_DISABLED_REASON });
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { modules, driftDisable };
}
