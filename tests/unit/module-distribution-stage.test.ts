// #1223: a pre-existing .prev-<module> backup (any owner) must not wedge update/remove.
// stageModuleDir clears it before rotating; an impossible-to-clear leftover produces an
// actionable error instead of a bare EACCES. sweepStagingDirs is opportunistic crash
// cleanup (reconcile phase 1) — one poisoned entry must not abort sweeping the others.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, afterAll, describe, expect, it } from "vitest";

import {
  StagePrevCleanupError,
  stageModuleDir,
  sweepStagingDirs
} from "../../packages/module-registry/src/distribution/stage.js";

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Lock a directory so files inside it cannot be unlinked (simulates a foreign-owned leftover). */
function lockDir(dir: string): void {
  writeFileSync(join(dir, "owned-by-someone-else.txt"), "x");
  chmodSync(dir, 0o500);
}

function forceCleanup(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) forceCleanup(dir);
});
afterAll(() => {
  for (const dir of dirs) forceCleanup(dir);
});

describe("stageModuleDir (#1223)", () => {
  it("clears a pre-existing .prev-<id> backup and completes the swap", () => {
    const modulesDir = tmp("modules-");
    mkdirSync(join(modulesDir, ".prev-job-search"));
    writeFileSync(join(modulesDir, ".prev-job-search", "stale.txt"), "old");
    const extracted = tmp("extracted-");
    writeFileSync(join(extracted, "jarvis.module.json"), "{}");

    stageModuleDir(extracted, modulesDir, "job-search");

    expect(existsSync(join(modulesDir, "job-search", "jarvis.module.json"))).toBe(true);
    expect(existsSync(join(modulesDir, ".prev-job-search"))).toBe(false);
  });

  it("throws StagePrevCleanupError naming the path when the backup cannot be cleared, leaving the live dir untouched", () => {
    const modulesDir = tmp("modules-");
    const target = join(modulesDir, "job-search");
    mkdirSync(target);
    writeFileSync(join(target, "jarvis.module.json"), "{}");
    const prev = join(modulesDir, ".prev-job-search");
    mkdirSync(prev);
    lockDir(prev);
    const extracted = tmp("extracted-");
    writeFileSync(join(extracted, "jarvis.module.json"), "{}");

    let caught: unknown;
    try {
      stageModuleDir(extracted, modulesDir, "job-search");
    } catch (error) {
      caught = error;
    } finally {
      chmodSync(prev, 0o700);
    }

    expect(caught).toBeInstanceOf(StagePrevCleanupError);
    expect((caught as Error).message).toContain(prev);
    expect(existsSync(join(target, "jarvis.module.json"))).toBe(true);
  });
});

describe("sweepStagingDirs (#1223)", () => {
  it("removes every .staging-*/.prev-* entry in one pass", () => {
    const modulesDir = tmp("modules-");
    mkdirSync(join(modulesDir, ".staging-a"));
    mkdirSync(join(modulesDir, ".prev-b"));
    mkdirSync(join(modulesDir, "job-search"));

    sweepStagingDirs(modulesDir);

    const remaining = readdirSync(modulesDir);
    expect(remaining).toEqual(["job-search"]);
  });

  it("does not let one poisoned entry abort sweeping the others", () => {
    const modulesDir = tmp("modules-");
    const poisoned = join(modulesDir, ".prev-poisoned");
    mkdirSync(poisoned);
    lockDir(poisoned);
    mkdirSync(join(modulesDir, ".staging-clean"));

    try {
      sweepStagingDirs(modulesDir);
    } finally {
      chmodSync(poisoned, 0o700);
    }

    expect(existsSync(join(modulesDir, ".staging-clean"))).toBe(false);
  });
});
