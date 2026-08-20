import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";

import type {
  ModuleCatalogPublicKey,
  ModuleRegistryArtifactRef,
  ModuleRegistryEntry
} from "../../packages/module-registry/src/node.js";
import { verifyCatalogBytes } from "../../packages/module-registry/src/node.js";
import {
  assertSignatureRequirementSatisfied,
  buildRegistryArtifacts,
  discoverModuleDirs,
  artifactIdentityDrift,
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
    ).toThrow(/bump demo-module's version/);
  });

  // #1747: the message is the whole fix for the "silent at the point of cause" half of this bug.
  // Whoever reads it is usually the author of an unrelated merge who never opened this module, so
  // asserting the wording is asserting the behaviour: a message that named only the version sent
  // people looking for an edit to a released module that nobody had made.
  it("names the module, the drifted fields, and the shared package that causes this", () => {
    let message = "";
    try {
      mergePreviousVersions(entry("1.0.0", [ref("0.9.0")]), {
        ...ref("1.0.0"),
        sha256: "b".repeat(64),
        sizeBytes: 11
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("demo-module 1.0.0");
    expect(message).toContain("sha256, sizeBytes");
    expect(message).toContain("packages/module-sdk");
    expect(message).toContain("external-modules/demo-module/jarvis.module.json");
    // The blast radius is the other half of why this was bad out of proportion to its cause.
    expect(message).toContain("all-or-nothing");
  });
});

describe("artifactIdentityDrift", () => {
  it("reports no drift for a byte-identical rerun of the same version", () => {
    expect(artifactIdentityDrift(entry("1.0.0", []), ref("1.0.0"))).toEqual([]);
  });

  it("reports no drift against a different version — that is a normal release", () => {
    expect(artifactIdentityDrift(entry("1.0.0", []), ref("1.1.0"))).toEqual([]);
  });

  it("reports no drift when the module has never been published", () => {
    expect(artifactIdentityDrift(undefined, ref("1.0.0"))).toEqual([]);
  });

  it("lists every part of the identity that moved", () => {
    expect(
      artifactIdentityDrift(entry("1.0.0", []), {
        ...ref("1.0.0"),
        artifact: "demo-module-1.0.0-rebuilt.tgz",
        sha256: "b".repeat(64),
        sizeBytes: 11
      })
    ).toEqual(["artifact", "sha256", "sizeBytes"]);
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

function makeSigningKeyPair(keyId: string): {
  signingKey: { keyId: string; privateKeyPem: string };
  trustedKeys: readonly ModuleCatalogPublicKey[];
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    signingKey: {
      keyId,
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    },
    trustedKeys: [
      { keyId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() }
    ]
  };
}

describe("buildRegistryArtifacts signing (#1319 Task 2)", () => {
  const scratchOutDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchOutDirs) rmSync(dir, { recursive: true, force: true });
  });

  async function publishOneModule(
    opts: Partial<Parameters<typeof buildRegistryArtifacts>[0]> = {}
  ): Promise<{ outDir: string }> {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const moduleDirs = discoverModuleDirs(repoRoot).slice(0, 1);
    const outDir = mkdtempSync(join(tmpdir(), "registry-signing-"));
    scratchOutDirs.push(outDir);
    await buildRegistryArtifacts({
      moduleDirs,
      outDir,
      previousIndex: null,
      generatedAt: new Date().toISOString(),
      signingKey: null,
      ...opts
    });
    return { outDir };
  }

  it("with a signing key: writes index.json.sig that verifies over the written index.json bytes", async () => {
    const { signingKey, trustedKeys } = makeSigningKeyPair("test-catalog-key");
    const { outDir } = await publishOneModule({ signingKey, trustedKeys });

    const sigPath = join(outDir, "index.json.sig");
    expect(existsSync(sigPath)).toBe(true);
    const signature: unknown = JSON.parse(readFileSync(sigPath, "utf8"));
    expect(signature).toMatchObject({
      formatVersion: 1,
      algorithm: "ed25519",
      keyId: "test-catalog-key"
    });

    const indexBytes = readFileSync(join(outDir, "index.json"));
    expect(verifyCatalogBytes(indexBytes, signature, trustedKeys)).toEqual({
      verified: true,
      keyId: "test-catalog-key"
    });
  });

  it("without a signing key: no index.json.sig is written", async () => {
    const { outDir } = await publishOneModule();
    expect(existsSync(join(outDir, "index.json.sig"))).toBe(false);
  });

  it("byte tampered after publish fails verification (byte-exactness through the file round-trip)", async () => {
    const { signingKey, trustedKeys } = makeSigningKeyPair("test-catalog-key");
    const { outDir } = await publishOneModule({ signingKey, trustedKeys });

    const signature: unknown = JSON.parse(readFileSync(join(outDir, "index.json.sig"), "utf8"));
    const indexBytes = readFileSync(join(outDir, "index.json"));
    const tampered = Buffer.concat([indexBytes, Buffer.from("\n")]);

    expect(verifyCatalogBytes(indexBytes, signature, trustedKeys)).toEqual({
      verified: true,
      keyId: "test-catalog-key"
    });
    expect(verifyCatalogBytes(tampered, signature, trustedKeys)).toEqual({
      verified: false,
      reason: "signature-mismatch"
    });
  });

  it("signing keyId absent from the trusted keyring: buildRegistryArtifacts throws (D7 self-verification)", async () => {
    const { signingKey } = makeSigningKeyPair("test-catalog-key");
    await expect(publishOneModule({ signingKey, trustedKeys: [] })).rejects.toThrow(
      /self-verification/
    );
  });
});

describe("assertSignatureRequirementSatisfied (#1319 ledger #24)", () => {
  it("throws when --require-signature is set but no signing key is configured", () => {
    expect(() => assertSignatureRequirementSatisfied(true, null)).toThrow(/--require-signature/);
  });

  it("does not throw when --require-signature is set and a signing key is configured", () => {
    expect(() =>
      assertSignatureRequirementSatisfied(true, { keyId: "k", privateKeyPem: "pem" })
    ).not.toThrow();
  });

  it("does not throw when --require-signature is not set, regardless of signing key", () => {
    expect(() => assertSignatureRequirementSatisfied(false, null)).not.toThrow();
  });
});
