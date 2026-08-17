// #964: atomic-ish staging of an extracted module into the modules directory. Work
// happens in dot-prefixed siblings of the final path (same filesystem → rename is
// atomic; dot-prefix means the discovery scanner never sees partial state — it lists
// module dirs by manifest presence and these names can never be a module id, which
// must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).
import { existsSync, renameSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const stagingDirFor = (modulesDir: string, moduleId: string): string =>
  join(modulesDir, `.staging-${moduleId}`);

const prevDirFor = (modulesDir: string, moduleId: string): string =>
  join(modulesDir, `.prev-${moduleId}`);

/** #1223: a pre-existing .prev-<id> (any owner) that stageModuleDir cannot clear before rotating. */
export class StagePrevCleanupError extends Error {
  constructor(path: string) {
    super(
      `cannot clear stale backup at "${path}" — remove it manually (e.g. sudo rm -rf "${path}") and retry`
    );
    this.name = "StagePrevCleanupError";
  }
}

/**
 * Swap extractedDir into place as modulesDir/moduleId. If a version is already
 * installed it is parked at .prev-<id> and restored when the swap fails, so a crash
 * mid-update never leaves the module missing.
 */
export function stageModuleDir(extractedDir: string, modulesDir: string, moduleId: string): void {
  const target = join(modulesDir, moduleId);
  const prev = prevDirFor(modulesDir, moduleId);
  try {
    rmSync(prev, { recursive: true, force: true });
  } catch {
    throw new StagePrevCleanupError(prev);
  }
  const hadPrevious = existsSync(target);
  if (hadPrevious) renameSync(target, prev);
  try {
    renameSync(extractedDir, target);
  } catch (error) {
    if (hadPrevious) renameSync(prev, target);
    throw error;
  }
  rmSync(prev, { recursive: true, force: true });
}

/** Remove leftover .staging-* / .prev-* from a crashed earlier run (reconcile phase 1). */
export function sweepStagingDirs(modulesDir: string): void {
  if (!existsSync(modulesDir)) return;
  for (const name of readdirSync(modulesDir)) {
    if (name.startsWith(".staging-") || name.startsWith(".prev-")) {
      try {
        rmSync(join(modulesDir, name), { recursive: true, force: true });
      } catch {
        // Opportunistic crash cleanup (reconcile phase 1) — a foreign-owned leftover must not
        // abort sweeping the other entries. stageModuleDir's StagePrevCleanupError is the
        // authoritative wedge-fix on the live rotation path.
      }
    }
  }
}
