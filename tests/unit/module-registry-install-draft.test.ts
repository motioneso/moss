import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  installModuleDraft,
  validateExternalModuleManifest,
  type InstallModuleDraftDeps
} from "../../packages/module-registry/src/node.js";

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const validManifest = {
  schemaVersion: 1,
  id: "videos",
  name: "Videos",
  version: "0.1.0",
  publisher: "Builder",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" }
};

/** Write a fake generated build's output dir, valid or with a validator-rejected manifest. */
function writeFakeGeneratedModule(root: string, opts: { id: string; valid: boolean }): string {
  const dir = join(root, opts.id);
  mkdirSync(dir, { recursive: true });
  const manifest = opts.valid
    ? { ...validManifest, id: opts.id }
    : { ...validManifest, id: opts.id, name: undefined };
  writeFileSync(join(dir, "jarvis.module.json"), JSON.stringify(manifest));
  return dir;
}

function makeDeps(modulesDir: string): {
  deps: InstallModuleDraftDeps;
  rows: Array<{ id: string; manifestHash: string; packageHash: string; ownerUserId: string }>;
} {
  const rows: Array<{
    id: string;
    manifestHash: string;
    packageHash: string;
    ownerUserId: string;
  }> = [];
  return {
    deps: {
      modulesDir,
      validateExternalModuleManifest,
      isModuleIdAvailable: async () => true,
      writeDraftRow: async (input) => {
        rows.push(input);
      }
    },
    rows
  };
}

describe("installModuleDraft (#1754)", () => {
  it("installs a valid generated module as a draft owned by its builder", async () => {
    const buildsRoot = tmp("install-draft-src-");
    const modulesDir = join(tmp("install-draft-modules-"), "modules");
    const buildDir = writeFakeGeneratedModule(buildsRoot, { id: "videos", valid: true });
    const { deps, rows } = makeDeps(modulesDir);

    const result = await installModuleDraft(deps, buildDir, "user-a");

    expect(result).toEqual({ ok: true, moduleId: "videos" });
    expect(rows).toEqual([
      {
        id: "videos",
        manifestHash: expect.stringMatching(/^sha256:/),
        packageHash: expect.stringMatching(/^sha256:/),
        ownerUserId: "user-a"
      }
    ]);
    // moved into modulesDir/<id>, not left at the build-source path
    expect(existsSync(buildDir)).toBe(false);
    expect(existsSync(join(modulesDir, "videos", "jarvis.module.json"))).toBe(true);
  });

  it("refuses an install when the generated manifest fails validation, same as a hand-written one would", async () => {
    const buildsRoot = tmp("install-draft-src-");
    const modulesDir = tmp("install-draft-modules-");
    const buildDir = writeFakeGeneratedModule(buildsRoot, { id: "videos", valid: false });
    const { deps, rows } = makeDeps(modulesDir);

    const result = await installModuleDraft(deps, buildDir, "user-a");

    expect(result.ok).toBe(false);
    expect(rows).toEqual([]);
    // left untouched — no row write, no move
    expect(existsSync(buildDir)).toBe(true);
    expect(existsSync(join(modulesDir, "videos"))).toBe(false);
  });

  it("returns an actionable error instead of throwing when the build never wrote a manifest (#2154)", async () => {
    const buildDir = tmp("install-draft-src-");
    const modulesDir = tmp("install-draft-modules-");
    const { deps, rows } = makeDeps(modulesDir);

    const result = await installModuleDraft(deps, buildDir, "user-a");

    expect(result).toEqual({
      ok: false,
      errors: ["the build did not produce jarvis.module.json"]
    });
    expect(rows).toEqual([]);
  });

  it("does not replace an existing module that chose the same id", async () => {
    const buildsRoot = tmp("install-draft-src-");
    const modulesDir = tmp("install-draft-modules-");
    const buildDir = writeFakeGeneratedModule(buildsRoot, { id: "videos", valid: true });
    mkdirSync(join(modulesDir, "videos"));
    const { deps, rows } = makeDeps(modulesDir);

    const result = await installModuleDraft(deps, buildDir, "user-a");

    expect(result).toEqual({ ok: false, errors: ['module id "videos" is already in use'] });
    expect(rows).toEqual([]);
    expect(existsSync(buildDir)).toBe(true);
  });
});
