// #1754: install a finished build's output as a draft, owned by the user who built it. Runs
// the same validator an admin-downloaded package goes through (no parallel, looser path per the
// Global Constraints), then reuses the admin-download pipeline's own stage/hash primitives so
// the on-disk move and the trusted-hash capture are the exact code an admin install already
// relies on. Server-only (node:* via stageModuleDir/hashExternalPackage).
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { hashCanonicalManifest, hashExternalPackage } from "./hash.js";
import type { validateExternalModuleManifest } from "./validate.js";
import { stageModuleDir } from "../distribution/stage.js";

export interface InstallModuleDraftDeps {
  readonly modulesDir: string;
  readonly validateExternalModuleManifest: typeof validateExternalModuleManifest;
  readonly isModuleIdAvailable: (moduleId: string) => Promise<boolean>;
  readonly writeDraftRow: (input: {
    readonly id: string;
    readonly manifestHash: string;
    readonly packageHash: string;
    readonly ownerUserId: string;
  }) => Promise<void>;
}

export type InstallModuleDraftResult =
  | { readonly ok: true; readonly moduleId: string }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_MANIFEST_BYTES = 64 * 1024;

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
  ownerUserId: string
): Promise<InstallModuleDraftResult> {
  const manifestPath = join(buildSourceDir, "jarvis.module.json");
  let manifestSize: number;
  try {
    manifestSize = statSync(manifestPath).size;
  } catch {
    return { ok: false, errors: ["the build did not produce jarvis.module.json"] };
  }
  if (manifestSize > MAX_MANIFEST_BYTES) {
    return { ok: false, errors: ["jarvis.module.json is too large"] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, errors: ["jarvis.module.json is not valid JSON"] };
  }
  const moduleId =
    typeof raw === "object" && raw !== null && "id" in raw ? (raw as { id?: unknown }).id : null;
  if (typeof moduleId !== "string") {
    return { ok: false, errors: ["jarvis.module.json must contain a module id"] };
  }
  const validated = deps.validateExternalModuleManifest(raw, moduleId);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  if (existsSync(join(deps.modulesDir, moduleId)) || !(await deps.isModuleIdAvailable(moduleId))) {
    return { ok: false, errors: [`module id "${moduleId}" is already in use`] };
  }

  const packageHash = hashExternalPackage(buildSourceDir);
  const manifestHash = hashCanonicalManifest(validated.manifest);
  mkdirSync(deps.modulesDir, { recursive: true });
  stageModuleDir(buildSourceDir, deps.modulesDir, moduleId);
  await deps.writeDraftRow({ id: moduleId, manifestHash, packageHash, ownerUserId });
  return { ok: true, moduleId };
}
