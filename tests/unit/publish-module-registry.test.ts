import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";

import type {
  ModuleRegistryArtifactRef,
  ModuleRegistryEntry
} from "../../packages/module-registry/src/node.js";
import {
  buildRegistryArtifacts,
  discoverModuleDirs,
  mergePreviousVersions,
  packModuleArtifact,
  REGISTRY_RETAINED_VERSIONS
} from "../../scripts/publish-module-registry.js";

const ref = (version: string): ModuleRegistryArtifactRef => ({
  version,
  artifact: `demo-module-${version}.tgz`,
  sha256: "a".repeat(64),
  sizeBytes: 10
});

const entry = (version: string, previous: ModuleRegistryArtifactRef[]): ModuleRegistryEntry => ({
  id: "demo-module",
  name: "Demo Module",
  description: null,
  requiresCore: ">=0.0.0",
  capabilities: { permissions: [], fetchHosts: [], tools: [], ownsTables: [] },
  previousVersions: previous,
  ...ref(version)
});

describe("mergePreviousVersions", () => {
  it("moves the old current version to the head of previousVersions", () => {
    const merged = mergePreviousVersions(entry("1.0.0", [ref("0.9.0")]), ref("1.1.0"));
    expect(merged.map((r) => r.version)).toEqual(["1.0.0", "0.9.0"]);
  });

  it("caps retained versions at REGISTRY_RETAINED_VERSIONS total (current + previous)", () => {
    const previous = ["1.4.0", "1.3.0", "1.2.0", "1.1.0"].map(ref);
    const merged = mergePreviousVersions(entry("1.5.0", previous), ref("1.6.0"));
    expect(merged).toHaveLength(REGISTRY_RETAINED_VERSIONS - 1);
    expect(merged.map((r) => r.version)).toEqual(["1.5.0", "1.4.0", "1.3.0", "1.2.0"]);
  });

  it("allows an identical same-version rerun without duplicating it", () => {
    const merged = mergePreviousVersions(entry("1.0.0", [ref("0.9.0")]), ref("1.0.0"));
    expect(merged.map((r) => r.version)).toEqual(["0.9.0"]);
  });

  it.each([
    ["artifact", { artifact: "demo-module-1.0.0-rebuilt.tgz" }],
    ["sha256", { sha256: "b".repeat(64) }],
    ["sizeBytes", { sizeBytes: 11 }]
  ])("rejects same-version republishing when %s differs", (_field, changed) => {
    expect(() =>
      mergePreviousVersions(entry("1.0.0", [ref("0.9.0")]), {
        ...ref("1.0.0"),
        ...changed
      })
    ).toThrow(/bump the module version/);
  });

  it("first publish (no existing entry) has empty previousVersions", () => {
    expect(mergePreviousVersions(undefined, ref("1.0.0"))).toEqual([]);
  });
});

describe("packModuleArtifact", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("packs manifest + dist/** + sql/** with a schema-valid filename, sha256, and size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-mod-"));
    const out = mkdtempSync(join(tmpdir(), "pack-out-"));
    dirs.push(dir, out);
    writeFileSync(join(dir, "jarvis.module.json"), "{}");
    mkdirSync(join(dir, "dist", "web"), { recursive: true });
    writeFileSync(join(dir, "dist", "worker.js"), "// worker");
    writeFileSync(join(dir, "dist", "web", "index.js"), "// web");
    mkdirSync(join(dir, "sql"));
    writeFileSync(join(dir, "sql", "0001_init.sql"), "CREATE TABLE app.job_search_x (id uuid);");
    writeFileSync(join(dir, "README.md"), "must NOT be packed");

    const packed = await packModuleArtifact(dir, out, "demo-module", "1.0.0");
    expect(packed.artifact).toBe("demo-module-1.0.0.tgz");
    expect(packed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(packed.sizeBytes).toBeGreaterThan(0);

    const entries: string[] = [];
    await tar.t({
      file: join(out, packed.artifact),
      onReadEntry: (e) => {
        entries.push(String(e.path));
      }
    });
    const files = entries.filter((p) => !p.endsWith("/"));
    expect(files.sort()).toEqual([
      "dist/web/index.js",
      "dist/worker.js",
      "jarvis.module.json",
      "sql/0001_init.sql"
    ]);
  });

  it("packs a module without sql/ (metadata-only module)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-nosql-"));
    const out = mkdtempSync(join(tmpdir(), "pack-nosql-out-"));
    dirs.push(dir, out);
    writeFileSync(join(dir, "jarvis.module.json"), "{}");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "worker.js"), "// worker");
    const packed = await packModuleArtifact(dir, out, "tiny", "0.1.0");
    expect(packed.artifact).toBe("tiny-0.1.0.tgz");
  });

  it("produces identical bytes when source mtimes differ", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-repro-"));
    const out1 = mkdtempSync(join(tmpdir(), "pack-repro-out1-"));
    const out2 = mkdtempSync(join(tmpdir(), "pack-repro-out2-"));
    dirs.push(dir, out1, out2);
    const manifest = join(dir, "jarvis.module.json");
    writeFileSync(manifest, "{}");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "worker.js"), "// worker");

    const first = await packModuleArtifact(dir, out1, "demo-module", "1.0.0");
    utimesSync(manifest, new Date("2020-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    const second = await packModuleArtifact(dir, out2, "demo-module", "1.0.0");

    expect(second.sha256).toBe(first.sha256);
    expect(second.sizeBytes).toBe(first.sizeBytes);
  });
});

describe("module discovery", () => {
  // Ruling N47 (#1307): the CLI entrypoint discovers modules generically via
  // discoverModuleDirs (readdirSync(external-modules/), no per-module allowlist, and
  // there must never be one — a hardcoded id would go stale the moment a module is
  // renamed or removed, silently or otherwise). Calling the exported discovery function
  // instead of re-implementing the walk here means an allowlist filter added to it later
  // makes this test fail, not just the packing step below. Combined with driving the real
  // buildRegistryArtifacts (the exact function the CLI calls) against every module it
  // finds, into a scratch out-dir, and asserting on what actually got published — entries
  // in the returned index, and a real tarball on disk for each — both halves of "the
  // publisher finds and packs everything" are now exercised, not assumed. Deliberately
  // not scoped to job-search alone — a test that only knows about one module has the same
  // asymmetry problem the publisher would have had. Measured ~50ms end to end for both
  // real modules (bundling included) — cheap enough not to fake.
  const scratchOutDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchOutDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("publishes every known external module, not a hardcoded subset", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const moduleDirs = discoverModuleDirs(repoRoot);

    const outDir = mkdtempSync(join(tmpdir(), "registry-discovery-"));
    scratchOutDirs.push(outDir);

    const index = await buildRegistryArtifacts({
      moduleDirs,
      outDir,
      previousIndex: null,
      generatedAt: new Date().toISOString(),
      signingKey: null
    });

    expect(index.modules.map((m) => m.id)).toEqual(
      expect.arrayContaining(["finance", "job-search"])
    );
    // Each index entry claims a packed artifact; confirm the tarball actually landed on
    // disk rather than trusting the returned object alone.
    for (const module of index.modules) {
      expect(existsSync(join(outDir, module.artifact))).toBe(true);
    }
  });
});
