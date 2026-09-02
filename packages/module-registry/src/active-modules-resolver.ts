import type { DataContextRunner } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import { SettingsRepository } from "@moss/settings";

import type { ActiveModulesResolver } from "@moss/ai";

export interface ActiveModulesResolverDeps {
  readonly dataContext: DataContextRunner;
  // #1902: a getter, not a captured array — called fresh on every resolve so a module
  // discovered after this resolver was constructed (e.g. an external module installed after
  // boot) is picked up without restarting the process.
  readonly manifests: () => readonly MossModuleManifest[];
}

/**
 * The real, DB-backed ActiveModulesResolver (ADR 0009 §3). Reads the
 * app.module_enablement deny-list under withDataContext (RLS returns instance rows ∪
 * this actor's own user rows), then filters the registered manifests by the layered
 * rule. The store is deny-only: absence of a row = enabled (honoring defaultEnabled,
 * true for all built-ins). required:true modules are never droppable.
 */
export function createActiveModulesResolver(
  deps: ActiveModulesResolverDeps
): ActiveModulesResolver {
  const repository = new SettingsRepository();

  return async (actorUserId: string): Promise<readonly MossModuleManifest[]> => {
    const denyRows = await deps.dataContext.withDataContext({ actorUserId }, (scopedDb) =>
      repository.listModuleDenyRowsForActor(scopedDb)
    );

    const instanceDisabled = new Set(
      denyRows.filter((r) => r.scope === "instance").map((r) => r.module_id)
    );
    const userDisabled = new Set(
      denyRows
        .filter((r) => r.scope === "user" && r.user_id === actorUserId)
        .map((r) => r.module_id)
    );

    return deps.manifests().filter((manifest) => {
      const availability = manifest.availability;
      // required:true → always keep (ignore any row; defense-in-depth).
      if (availability?.required === true) return true;
      // instance disable is a hard floor for everyone.
      if (instanceDisabled.has(manifest.id)) return false;
      // per-user disable only applies when the manifest permits it.
      if (availability?.supportsUserDisable !== false && userDisabled.has(manifest.id)) {
        return false;
      }
      return true;
    });
  };
}
