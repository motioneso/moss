import type { DataContextDb } from "@moss/db";
import type { VaultIngestRootProvider } from "@moss/module-sdk";

import { EntitiesRepository } from "./entities-repository.js";
import { STRUCTURED_STATE_MODULE_ID } from "./manifest.js";

/**
 * Registration-only: resolves every visible entity's linked note as an ingestable root.
 * structured-state has no live producer, so it never calls scheduleVaultIngestNudge itself —
 * entity-linked notes are picked up by the periodic sweep.
 */
export function createStructuredStateVaultIngestProvider(
  entitiesRepository: EntitiesRepository = new EntitiesRepository()
): VaultIngestRootProvider {
  return {
    moduleId: STRUCTURED_STATE_MODULE_ID,
    async resolveRoots(scopedDb: DataContextDb, _ownerUserId: string): Promise<readonly string[]> {
      const entities = await entitiesRepository.listVisible(scopedDb);
      return entities
        .map((entity) => entity.vault_note_path)
        .filter((path): path is string => typeof path === "string" && path.length > 0);
    }
  };
}
