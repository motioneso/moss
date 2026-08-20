// scripts/publish-module-registry.ts
// #964: builds the module-registry publication set. For every module directory given
// (default: each child of external-modules/), it runs the JS-01 bundler, validates the
// manifest, packs a portable gzip tarball of exactly the on-disk trust set
// (jarvis.module.json + dist/** + sql/**), and emits index.json conforming to Task 1's
// registry schema. Runs only in CI (modules-registry.yml) and locally for testing —
// external-modules/ is dockerignored, the core image never ships it. Retention:
// current + 4 previous versions per module.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as tar from "tar";

import {
  ARTIFACT_FILENAME_RE,
  MODULE_CATALOG_PUBLIC_KEYS,
  REGISTRY_INDEX_SCHEMA_VERSION,
  resolveCatalogSigningKey,
  signCatalogBytes,
  validateExternalModuleManifest,
  validateRegistryIndex,
  verifyCatalogBytes,
  type ModuleCatalogPublicKey,
  type ModuleRegistryArtifactRef,
  type ModuleRegistryEntry,
  type ModuleRegistryIndex
} from "../packages/module-registry/src/node.js";
import { buildExternalModule } from "./build-external-module.js";

export const REGISTRY_RETAINED_VERSIONS = 5;

/**
 * Generic module discovery (N47, #1307): every child directory of `external-modules/`
 * under `repoRoot`, no per-module allowlist. Exported so a test can drive the exact
 * discovery the CLI runs — a copy re-implemented inline in a test would pass even if an
 * allowlist filter were added here later.
 */
export function discoverModuleDirs(repoRoot: string): string[] {
  const externalModulesDir = join(repoRoot, "external-modules");
  return readdirSync(externalModulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(externalModulesDir, e.name));
}

/**
 * Which parts of a published artifact's identity a rebuild changed. Empty means the rebuild is
 * byte-identical to what is already published under that version, so the publish is a no-op rerun.
 *
 * #1747: exported because the pre-merge check (`--check`) needs the same comparison the publisher
 * enforces. A check that re-implemented the rule would drift from it and pass a PR the publisher
 * then rejects, which is the exact failure mode the check exists to prevent.
 */
export function artifactIdentityDrift(
  existing: ModuleRegistryEntry | undefined,
  next: ModuleRegistryArtifactRef
): readonly string[] {
  if (!existing || existing.version !== next.version) return [];
  const drift: string[] = [];
  if (existing.artifact !== next.artifact) drift.push("artifact");
  if (existing.sha256 !== next.sha256) drift.push("sha256");
  if (existing.sizeBytes !== next.sizeBytes) drift.push("sizeBytes");
  return drift;
}

/**
 * #1747: the old message named only the version and said "bump the module version", which reads as
 * "someone edited a released module". The real cause is almost always the opposite — nobody touched
 * this module at all, and a shared package that gets bundled into every module's `dist/` moved
 * underneath it. Whoever hits this is usually the author of an unrelated merge, so the message has
 * to explain a situation they have no context for.
 */
function versionConflictMessage(id: string, version: string, drift: readonly string[]): string {
  return (
    `refusing to republish ${id} ${version}: the packaged artifact no longer matches the one ` +
    `already published under that version (${drift.join(", ")} changed).\n` +
    `If ${id}'s own source did not change, a shared package did — packages/module-sdk is bundled ` +
    `into every module's dist/, so a change there re-packs every module at once.\n` +
    `Fix: bump ${id}'s version in external-modules/${id}/jarvis.module.json.\n` +
    `Note this publish is all-or-nothing: every other module stays stranded at its old version ` +
    `until this is resolved.`
  );
}

/**
 * Fold the previous index entry's current version into previousVersions, newest first,
 * capped so current + previous ≤ REGISTRY_RETAINED_VERSIONS. An identical same-version
 * rerun is idempotent; a changed artifact identity requires a version bump.
 */
export function mergePreviousVersions(
  existing: ModuleRegistryEntry | undefined,
  next: ModuleRegistryArtifactRef
): readonly ModuleRegistryArtifactRef[] {
  if (!existing) return [];
  const drift = artifactIdentityDrift(existing, next);
  if (drift.length > 0) {
    throw new Error(versionConflictMessage(existing.id, next.version, drift));
  }
  const chain: ModuleRegistryArtifactRef[] = [
    {
      version: existing.version,
      artifact: existing.artifact,
      sha256: existing.sha256,
      sizeBytes: existing.sizeBytes
    },
    ...existing.previousVersions
  ];
  return chain.filter((r) => r.version !== next.version).slice(0, REGISTRY_RETAINED_VERSIONS - 1);
}

/** Pack the module's trust set into `<id>-<version>.tgz` and return its artifact ref. */
export async function packModuleArtifact(
  moduleDir: string,
  outDir: string,
  id: string,
  version: string
): Promise<ModuleRegistryArtifactRef> {
  const artifact = `${id}-${version}.tgz`;
  if (!ARTIFACT_FILENAME_RE.test(artifact)) {
    throw new Error(`artifact filename fails registry schema: ${artifact}`);
  }
  // Exactly the hashable set from external/hash.ts (#964 Task 2) — nothing else.
  // README, src/, node_modules must never reach the wire.
  const members = ["jarvis.module.json", "dist"];
  if (existsSync(join(moduleDir, "sql"))) members.push("sql");
  const file = join(outDir, artifact);
  // portable: strips uid/gid/atime metadata so identical trees pack identically.
  await tar.create(
    { gzip: true, portable: true, mtime: new Date(0), cwd: resolve(moduleDir), file },
    members
  );
  const bytes = readFileSync(file);
  return {
    version,
    artifact,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: statSync(file).size
  };
}

export interface BuildRegistryArtifactsOptions {
  readonly moduleDirs: readonly string[];
  readonly outDir: string;
  readonly previousIndex: ModuleRegistryIndex | null;
  readonly generatedAt: string;
  readonly signingKey: { keyId: string; privateKeyPem: string } | null;
  /**
   * Keyring the fresh signature self-checks against (D7). Defaults to the real pinned
   * `MODULE_CATALOG_PUBLIC_KEYS` — production publishes must never override this. Tests inject an
   * ephemeral keyring here because the pinned array stays empty (D8) until Ben provisions the
   * real production key.
   */
  readonly trustedKeys?: readonly ModuleCatalogPublicKey[];
}

/**
 * #1319 ledger #24 / story 13: factored out so a unit test can drive `--require-signature`
 * without spawning the CLI as a subprocess.
 */
export function assertSignatureRequirementSatisfied(
  requireSignature: boolean,
  signingKey: { keyId: string; privateKeyPem: string } | null
): void {
  if (requireSignature && !signingKey) {
    throw new Error(
      "--require-signature was set but no signing key is configured " +
        "(MOSS_MODULE_CATALOG_SIGNING_KEY_ID / MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY)"
    );
  }
}

/**
 * Build, validate and pack one module. Factored out (#1747) so the pre-merge check and the real
 * publish produce the artifact the same way — a check that packed differently would compare the
 * wrong bytes and clear a PR the publisher then rejects.
 */
// Return type is inferred rather than annotated: the validated-manifest type is internal to
// packages/module-registry and not exported from its node entrypoint.
async function buildAndPackModule(moduleDir: string, outDir: string) {
  const id = basename(resolve(moduleDir));
  await buildExternalModule(moduleDir);
  const raw: unknown = JSON.parse(readFileSync(join(moduleDir, "jarvis.module.json"), "utf8"));
  const validation = validateExternalModuleManifest(raw, id);
  if (!validation.ok) {
    // Fail the whole publish: a broken manifest must never reach the registry.
    throw new Error(`manifest invalid for ${id}: ${validation.errors.join("; ")}`);
  }
  const manifest = validation.manifest;
  const ref = await packModuleArtifact(moduleDir, outDir, id, manifest.version);
  return { id, manifest, ref };
}

/**
 * #1747 option 1: answer "would publishing this tree right now be rejected?" for EVERY module,
 * rather than stopping at the first. The publisher throws on the first conflict, which is right for
 * a publish and wrong for a check — a PR author needs the full list of versions to bump in one
 * pass, not one per CI round trip.
 *
 * Returns one message per stranded module; empty means the tree is publishable.
 */
export async function findVersionConflicts(options: {
  readonly moduleDirs: readonly string[];
  readonly outDir: string;
  readonly previousIndex: ModuleRegistryIndex | null;
}): Promise<readonly string[]> {
  mkdirSync(options.outDir, { recursive: true });
  const conflicts: string[] = [];
  for (const moduleDir of options.moduleDirs) {
    const { id, ref } = await buildAndPackModule(moduleDir, options.outDir);
    const existing = options.previousIndex?.modules.find((m) => m.id === id);
    const drift = artifactIdentityDrift(existing, ref);
    if (drift.length > 0) conflicts.push(versionConflictMessage(id, ref.version, drift));
  }
  return conflicts;
}

export async function buildRegistryArtifacts(
  options: BuildRegistryArtifactsOptions
): Promise<ModuleRegistryIndex> {
  mkdirSync(options.outDir, { recursive: true });
  const modules: ModuleRegistryEntry[] = [];
  for (const moduleDir of options.moduleDirs) {
    const { id, manifest, ref } = await buildAndPackModule(moduleDir, options.outDir);
    const existing = options.previousIndex?.modules.find((m) => m.id === id);
    modules.push({
      ...ref,
      id,
      name: manifest.name,
      description: manifest.description ?? null,
      requiresCore: manifest.compatibility.jarv1s,
      capabilities: {
        permissions: [...new Set((manifest.assistantTools ?? []).map((t) => t.permissionId))],
        fetchHosts: manifest.fetchHosts ?? [],
        tools: (manifest.assistantTools ?? []).map((t) => ({ name: t.name, risk: t.risk })),
        ownsTables: manifest.database?.ownedTables ?? []
      },
      previousVersions: mergePreviousVersions(existing, ref)
    });
  }
  const index: ModuleRegistryIndex = {
    schemaVersion: REGISTRY_INDEX_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    modules
  };
  // Self-check: the index we publish must round-trip our own validator.
  const check = validateRegistryIndex(JSON.parse(JSON.stringify(index)));
  if (!check.index || check.errors.length > 0) {
    throw new Error(`generated index fails own schema: ${check.errors.join("; ")}`);
  }
  const indexJson = JSON.stringify(index, null, 2) + "\n";
  writeFileSync(join(options.outDir, "index.json"), indexJson);
  if (options.signingKey) {
    const bytes = Buffer.from(indexJson, "utf8");
    const signature = signCatalogBytes(
      bytes,
      options.signingKey.privateKeyPem,
      options.signingKey.keyId
    );
    const trustedKeys = options.trustedKeys ?? MODULE_CATALOG_PUBLIC_KEYS;
    const selfCheck = verifyCatalogBytes(bytes, signature, trustedKeys);
    if (!selfCheck.verified) {
      throw new Error(
        `self-verification of the freshly signed catalog failed (${selfCheck.reason}) — is keyId ` +
          `"${options.signingKey.keyId}" pinned in MODULE_CATALOG_PUBLIC_KEYS?`
      );
    }
    writeFileSync(
      join(options.outDir, "index.json.sig"),
      JSON.stringify(signature, null, 2) + "\n"
    );
  }
  return index;
}

// CLI: tsx scripts/publish-module-registry.ts --out dist/registry [--previous-index p]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = argValue("--out") ?? "dist/registry";
  const previousIndexPath = argValue("--previous-index");
  const requireSignature = argv.includes("--require-signature");
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const moduleDirs = discoverModuleDirs(repoRoot);
  let previousIndex: ModuleRegistryIndex | null = null;
  if (previousIndexPath && existsSync(previousIndexPath)) {
    const parsed = validateRegistryIndex(JSON.parse(readFileSync(previousIndexPath, "utf8")));
    // Tolerate a corrupt previous index (history reset) — warn and publish fresh.
    if (!parsed.index)
      console.warn(`previous index invalid, ignoring: ${parsed.errors.join("; ")}`);
    previousIndex = parsed.index;
  }
  // #1747 `--check`: build and pack everything, compare against the published index, report every
  // stranded module, write nothing and sign nothing. This runs on pull requests so a change to a
  // shared package fails on the PR that causes it, instead of on someone else's later merge.
  if (argv.includes("--check")) {
    findVersionConflicts({ moduleDirs, outDir, previousIndex })
      .then((conflicts) => {
        if (conflicts.length === 0) {
          console.log(`registry check: ${moduleDirs.length} module(s) publishable`);
          return;
        }
        console.error(conflicts.join("\n\n"));
        process.exit(1);
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  } else {
    const signingKey = resolveCatalogSigningKey(process.env);
    try {
      assertSignatureRequirementSatisfied(requireSignature, signingKey);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
    buildRegistryArtifacts({
      moduleDirs,
      outDir,
      previousIndex,
      generatedAt: new Date().toISOString(),
      signingKey
    })
      .then((index) => console.log(`published ${index.modules.length} module(s) to ${outDir}`))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  }
}
