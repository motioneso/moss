import { isAbsolute } from "node:path";

import type { DataContextDb } from "@moss/db";
import type { VaultIngestRootProvider } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { PEOPLE_MODULE_ID } from "./manifest.js";
import { PEOPLE_NOTES_FOLDER_PREFERENCE_KEY } from "./notes-service.js";

/**
 * Resolves the configured people-notes folder as the module's only ingestable root — empty
 * (nothing to ingest) until the owner sets one via PeopleNotesService.putSettings.
 *
 * #2268 — the People folder now normally lives in the user's notes tree, outside the private
 * per-user vault, and is stored as an absolute path. Roots handed to the private-vault sweep must
 * be relative to that vault, and one that escapes it makes the whole sweep throw, so an absolute
 * value contributes nothing here. Those notes are still indexed: the notes module already sweeps
 * the entire notes tree. Only a legacy relative value is still offered to the private sweep.
 */
export function createPeopleVaultIngestProvider(
  preferencesRepository: PreferencesRepository = new PreferencesRepository()
): VaultIngestRootProvider {
  return {
    moduleId: PEOPLE_MODULE_ID,
    async resolveRoots(scopedDb: DataContextDb, _ownerUserId: string): Promise<readonly string[]> {
      const stored = await preferencesRepository.get(scopedDb, PEOPLE_NOTES_FOLDER_PREFERENCE_KEY);
      if (typeof stored !== "string" || stored.length === 0) return [];
      if (isAbsolute(stored)) return [];
      return [stored];
    }
  };
}
