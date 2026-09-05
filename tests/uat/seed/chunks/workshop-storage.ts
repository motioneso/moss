import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { buildExternalModule } from "../../../../scripts/build-external-module.js";
import {
  installModuleDraft,
  resolveModulesDir,
  validateExternalModuleManifest
} from "@moss/module-registry/node";
import { SettingsRepository } from "@moss/settings";
import type { DataContextRunner } from "@moss/db";

const MODULE_ID = "uat-workshop-word";
const FIXTURE_DIR = resolve("tests/uat/fixtures/workshop-word");

/**
 * #2267: install the trusted storage fixture through the same draft installer used by the
 * module-build worker. The fixture is copied into the writable build volume first because the
 * application tree in the image is read-only; installModuleDraft then hashes, validates, stages,
 * and records the owner draft in one supported path.
 */
export async function installWorkshopStorageFixture(
  runner: DataContextRunner,
  ownerUserId: string
): Promise<void> {
  const modulesDir = resolveModulesDir(process.env);
  // Keep the source on the modules volume: installModuleDraft atomically renames it into the
  // final module directory, and a cross-filesystem rename from /data/module-builds would fail
  // against the named /data/modules volume.
  const buildDir = join(modulesDir, ".builds", MODULE_ID);
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(dirname(buildDir), { recursive: true });
  await cp(FIXTURE_DIR, buildDir, { recursive: true });
  await buildExternalModule(buildDir);

  const settings = new SettingsRepository();
  await runner.withDataContext({ actorUserId: ownerUserId }, async (scopedDb) => {
    const installed = await installModuleDraft(
      {
        modulesDir,
        validateExternalModuleManifest,
        isModuleIdAvailable: async (moduleId) =>
          !(await settings.listExternalModuleStates(scopedDb)).some(
            (module) => module.id === moduleId
          ),
        writeDraftRow: ({ id, manifestHash, packageHash, ownerUserId: draftOwner }) =>
          settings.setExternalModuleDraft(scopedDb, {
            id,
            manifestHash,
            packageHash,
            ownerUserId: draftOwner,
            actorUserId: ownerUserId,
            requestId: `uat-workshop-storage:${MODULE_ID}`
          })
      },
      buildDir,
      ownerUserId
    );
    if (!installed.ok) {
      throw new Error(`Workshop storage fixture failed validation: ${installed.errors.join("; ")}`);
    }
  });
}
