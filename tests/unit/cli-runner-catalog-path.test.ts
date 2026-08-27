/**
 * Regression test for the v0.1.0 install blocker (#342): the recipe-catalog lockfile path must
 * resolve correctly regardless of the runtime LAYOUT. `catalog.ts` is consumed BOTH by the
 * cli-runner (tsx, from packages/cli-runner/src) AND bundled into the api's dist/server.js — and
 * `scripts/build-app.ts` collapses `import.meta.url` to the bundle dir. The old fixed
 * `MODULE_DIR/../../..` offset therefore resolved the committed lockfile to `/` inside the bundled
 * api, reading "lockfile missing", which demoted claude/codex to `blocked` at catalog load and made
 * `POST /api/onboarding/provider-install` 400 before the RPC ever reached the cli-runner.
 *
 * The fix walks up to the `pnpm-workspace.yaml` repo-root marker, which is correct from src, a dist
 * bundle, and a test. These assertions fail against the old fixed-offset resolution.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATALOG_VALIDATION_ISSUES,
  PROVIDER_CATALOG,
  findRepoRoot
} from "../../packages/cli-runner/src/catalog.js";

const REPO_ROOT = process.cwd(); // vitest runs from the repo root

describe("catalog lockfile path resolution (#342 install blocker)", () => {
  it("findRepoRoot walks up to the pnpm-workspace.yaml marker from ANY layout depth", () => {
    // tsx layout (cli-runner runs from src)
    expect(findRepoRoot(path.join(REPO_ROOT, "packages", "cli-runner", "src"))).toBe(REPO_ROOT);
    // bundled-api layout (import.meta.url collapses to the dist dir) — the bug case
    expect(findRepoRoot(path.join(REPO_ROOT, "dist"))).toBe(REPO_ROOT);
    // deep nested
    expect(findRepoRoot(path.join(REPO_ROOT, "a", "b", "c", "d"))).toBe(REPO_ROOT);
  });

  it("the committed lockfiles are reachable from the resolved repo root (both layouts)", () => {
    for (const start of [
      path.join(REPO_ROOT, "packages", "cli-runner", "src"),
      path.join(REPO_ROOT, "dist")
    ]) {
      const root = findRepoRoot(start);
      expect(
        existsSync(path.join(root, "packages/cli-runner/recipes/anthropic/npm-shrinkwrap.json"))
      ).toBe(true);
      expect(
        existsSync(
          path.join(root, "packages/cli-runner/recipes/openai-compatible/npm-shrinkwrap.json")
        )
      ).toBe(true);
      expect(
        existsSync(path.join(root, "packages/cli-runner/recipes/google/npm-shrinkwrap.json"))
      ).toBe(true);
    }
  });

  it("every provider loads as `supported` (NOT demoted to blocked over a missing lockfile)", () => {
    expect(PROVIDER_CATALOG.anthropic.status).toBe("supported");
    expect(PROVIDER_CATALOG["openai-compatible"].status).toBe("supported");
    // #2026: google is pinned now too, so it is no longer excluded from this sweep.
    expect(PROVIDER_CATALOG.google.status).toBe("supported");
    // No lockfile-related demotion for ANY provider.
    const lockfileDemotions = CATALOG_VALIDATION_ISSUES.filter((i) => /lockfile/i.test(i.reason));
    expect(lockfileDemotions).toEqual([]);
  });

  // #2026: the whole point of the pin is that §A.1.4 accepts it. A recipe that is fake in ANY
  // way — missing/unreadable lockfile, a gap in the full-tree sha512 coverage, a range version,
  // a <PINNED_*> placeholder, `archOptionalDeps` set without both per-arch packages, or a
  // missing self-update-disable — is demoted to `blocked` at load, so these assertions fail.
  it("the google (Gemini) entry survives pin validation with its real recipe", () => {
    const entry = PROVIDER_CATALOG.google;
    expect(entry.status).toBe("supported");
    expect(CATALOG_VALIDATION_ISSUES.filter((i) => i.provider === "google")).toEqual([]);

    const recipe = entry.recipe;
    expect(recipe).toBeDefined();
    if (recipe?.kind !== "npm") throw new Error("expected an npm recipe for google");
    expect(recipe.pkg).toBe("@google/gemini-cli");
    expect(recipe.version).toBe("0.57.0");
    expect(recipe.lockfile).toBe("packages/cli-runner/recipes/google/npm-shrinkwrap.json");
    // The published package exposes exactly one command, `gemini`. Naming it `agy` here makes
    // the install fail verify with "installed package produced no executable".
    expect(recipe.binary).toBe("gemini");
    // The package is a single bundled JavaScript program, NOT a per-arch native binary.
    // Setting these would make §A.1.4 demand per-arch entries that do not exist.
    expect(recipe.archOptionalDeps).toBeUndefined();
    expect(recipe.archBinaryPackage).toBeUndefined();
    expect(recipe.archBinaryPlacement).toBeUndefined();
  });

  // The tool self-updates by spawning `npm install -g @google/gemini-cli@<newer>`, which would
  // silently replace the pinned bytes. Both `general` flags gate that path; either one left true
  // (or the wrong settings-file path) reopens it, so assert the exact written content.
  it("the google recipe turns the tool's own self-update off", () => {
    const recipe = PROVIDER_CATALOG.google.recipe;
    if (recipe?.kind !== "npm") throw new Error("expected an npm recipe for google");
    const sud = recipe.selfUpdateDisable;
    if (sud.kind !== "config") throw new Error("expected a config-file selfUpdateDisable");
    expect(sud.path).toBe(".gemini/settings.json");
    const parsed = JSON.parse(sud.content) as {
      general?: { enableAutoUpdate?: boolean; enableAutoUpdateNotification?: boolean };
    };
    expect(parsed.general?.enableAutoUpdate).toBe(false);
    expect(parsed.general?.enableAutoUpdateNotification).toBe(false);
  });

  // The committed lockfile must carry sha512 on the FULL transitive tree and resolve the exact
  // pinned version — a top-level-only pin would let a transitive dep drift.
  it("the committed google lockfile pins 0.57.0 with full-tree sha512 coverage", () => {
    const raw = readFileSync(
      path.join(REPO_ROOT, "packages/cli-runner/recipes/google/npm-shrinkwrap.json"),
      "utf8"
    );
    const lock = JSON.parse(raw) as {
      packages: Record<string, { integrity?: string; link?: boolean; version?: string }>;
    };
    const entries = Object.entries(lock.packages);
    expect(entries.length).toBeGreaterThan(1);
    const noIntegrity = entries
      .filter(([key, meta]) => key !== "" && meta.link !== true)
      .filter(([, meta]) => !meta.integrity?.startsWith("sha512-"))
      .map(([key]) => key);
    expect(noIntegrity).toEqual([]);
    expect(lock.packages["node_modules/@google/gemini-cli"]?.version).toBe("0.57.0");
  });

  // install-service.ts reads the SAME committed lockfile at install time (a SECOND read,
  // distinct from the catalog's load-time validation). #357 fixed only catalog.ts, so the
  // bundled api still ENOENT'd at install with the fixed MODULE_DIR/../../.. offset. This
  // collapse is invisible to a runtime test (it only manifests under esbuild bundling), so
  // guard at the source level — like the catalog fix, it must use the marker walk.
  it("install-service resolves the repo root via findRepoRoot, not a fixed offset", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "packages/cli-runner/src/install-service.ts"),
      "utf8"
    );
    expect(src).toMatch(/findRepoRoot\(/);
    expect(src).not.toMatch(/fileURLToPath\(import\.meta\.url\)\)\s*,\s*"\.\."\s*,\s*"\.\."/);
  });
});

// The cli-runner boot invocation must live ONLY in the never-imported main-entry.ts.
// main.ts is bundled into the api's dist/server.js (the api imports the cli-runner barrel),
// where import.meta.url collapses to the bundle URL == `file://${process.argv[1]}` — so an
// `if (isEntrypoint) main()` guard in main.ts MIS-FIRED and the api booted its own
// CliRunnerServer on the sidecar's socket. A runtime import can't reproduce the collapse
// (vitest's argv[1] never equals the module URL), so assert it at the source level.
describe("cli-runner boot has no importable side effect (#342 sidecar double-run)", () => {
  // Strip block + line comments so the assertions see executable code only (the fix's
  // explanatory comments deliberately mention import.meta.url / isEntrypoint).
  const readCode = (rel: string) =>
    readFileSync(path.join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

  it("main.ts does NOT invoke main() at module scope (no isEntrypoint guard)", () => {
    const code = readCode("packages/cli-runner/src/main.ts");
    expect(code).not.toMatch(/import\.meta\.url/);
    expect(code).not.toMatch(/^\s*main\(\)/m);
    expect(code).not.toMatch(/isEntrypoint/);
  });

  it("main-entry.ts is the sole side-effecting module (calls main())", () => {
    const src = read("packages/cli-runner/src/main-entry.ts");
    expect(src).toMatch(/import\s*\{\s*main\s*\}\s*from\s*"\.\/main\.js"/);
    expect(src).toMatch(/main\(\)\s*\.catch/);
  });
});
