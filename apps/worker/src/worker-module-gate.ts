import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";

import { DRIFT_DISABLED_REASON, type ExternalModuleDiscovery } from "@moss/module-registry";

/**
 * Is this module's queue registration live? Extracted from the inline callback passed to
 * `ExternalModuleJobReconciler` in worker.ts so it's unit-testable on its own (#1753 Task 9).
 *
 * A draft is exempt from the manifest/package hash check — same exemption reconcile.ts already
 * gives it (#1753 Task 6): a draft is edited live by its author, so a changed hash is expected,
 * not a signal to disable. Enabled modules keep the existing exact-hash-match requirement.
 */
export function createIsModuleEnabled(deps: {
  readonly db: Kysely<MossDatabase>;
  readonly getDiscoveryById: (moduleId: string) => ExternalModuleDiscovery | undefined;
}) {
  return async (moduleId: string): Promise<boolean> => {
    const module = deps.getDiscoveryById(moduleId);
    if (!module) return false;
    const state = await deps.db
      .selectFrom("app.external_modules")
      .select(["status", "manifest_hash", "package_hash"])
      .where("id", "=", moduleId)
      .executeTakeFirst();
    if (!state) return false;
    if (state.status === "draft") return true;
    return (
      state.status === "enabled" &&
      state.manifest_hash === module.manifestHash &&
      state.package_hash === module.packageHash
    );
  };
}

/**
 * Did an admin disable this module? True for status `disabled` with any reason except the
 * automatic package-drift disable, which clears on re-enable and must keep queued jobs.
 */
export function createIsModuleDisabledByAdmin(deps: { readonly db: Kysely<MossDatabase> }) {
  return async (moduleId: string): Promise<boolean> => {
    const state = await deps.db
      .selectFrom("app.external_modules")
      .select(["status", "disabled_reason"])
      .where("id", "=", moduleId)
      .executeTakeFirst();
    return state?.status === "disabled" && state.disabled_reason !== DRIFT_DISABLED_REASON;
  };
}
