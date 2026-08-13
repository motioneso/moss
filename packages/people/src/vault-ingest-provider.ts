import type { DataContextDb } from "@moss/db";
import type { VaultIngestRootProvider } from "@moss/memory";
import { PreferencesRepository } from "@moss/structured-state";

import { PEOPLE_MODULE_ID } from "./manifest.js";
import { PEOPLE_NOTES_FOLDER_PREFERENCE_KEY } from "./notes-service.js";

/**
 * Resolves the configured people-notes folder as the module's only ingestable root — empty
 * (nothing to ingest) until the owner sets one via PeopleNotesService.putSettings.
 */
export function createPeopleVaultIngestProvider(
  preferencesRepository: PreferencesRepository = new PreferencesRepository()
): VaultIngestRootProvider {
  return {
    moduleId: PEOPLE_MODULE_ID,
    async resolveRoots(scopedDb: DataContextDb, _ownerUserId: string): Promise<readonly string[]> {
      const stored = await preferencesRepository.get(scopedDb, PEOPLE_NOTES_FOLDER_PREFERENCE_KEY);
      return typeof stored === "string" && stored.length > 0 ? [stored] : [];
    }
  };
}
