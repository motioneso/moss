// #1754: install a finished build's output as a draft, owned by the user who built it. Runs
// the same validator an admin-downloaded package goes through (no parallel, looser path per the
// Global Constraints), then reuses the admin-download pipeline's own stage/hash primitives so
// the on-disk move and the trusted-hash capture are the exact code an admin install already
// relies on. Server-only (node:* via stageModuleDir/hashExternalPackage).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hashCanonicalManifest, hashExternalPackage } from "./hash.js";
import type { validateExternalModuleManifest } from "./validate.js";
import { stageModuleDir } from "../distribution/stage.js";

export interface InstallModuleDraftDeps {
  readonly modulesDir: string;
  readonly validateExternalModuleManifest: typeof validateExternalModuleManifest;
  readonly writeDraftRow: (input: {
    readonly id: string;
    readonly manifestHash: string;
    readonly packageHash: string;
    readonly ownerUserId: string;
  }) => Promise<void>;
}

export type InstallModuleDraftResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * `buildSourceDir` (Task 11's `module-builds/<id>`) is NOT scanned by the server's normal disk
 * scan (only `modulesDir` is) — so on success this moves it into `modulesDir/<moduleId>` via
 * `stageModuleDir`, the same atomic-rename primitive `downloadAndStageModule` uses. The tree is
 * hashed BEFORE the move: `buildSourceDir` no longer exists at that path once `stageModuleDir`
 * returns.
 */
export async function installModuleDraft(
  deps: InstallModuleDraftDeps,
  buildSourceDir: string,
  moduleId: string,
  ownerUserId: string
): Promise<InstallModuleDraftResult> {
  const raw: unknown = JSON.parse(readFileSync(join(buildSourceDir, "jarvis.module.json"), "utf8"));
  const validated = deps.validateExternalModuleManifest(raw, moduleId);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  const packageHash = hashExternalPackage(buildSourceDir);
  const manifestHash = hashCanonicalManifest(validated.manifest);
  stageModuleDir(buildSourceDir, deps.modulesDir, moduleId);
  await deps.writeDraftRow({ id: moduleId, manifestHash, packageHash, ownerUserId });
  return { ok: true };
}
