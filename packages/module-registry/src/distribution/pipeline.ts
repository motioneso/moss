// #964: the admin-download pipeline (spec §5): index → resolve → download →
// integrity → extract → manifest validation → version cross-check → atomic stage.
// #1319 inserts a catalog-signature check straight after the index fetch, before any
// bytes are downloaded or written.
// Everything before the final rename happens in dot-prefixed staging paths, so a
// failure at any step leaves the modules directory exactly as it was.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hashExternalPackage } from "../external/hash.js";
import { validateExternalModuleManifest } from "../external/validate.js";
import { ARTIFACT_MAX_BYTES, resolveRegistryArtifact } from "./index-schema.js";
import { safeExtractModuleTarball } from "./extract.js";
import {
  createRegistryFetch,
  downloadArtifactBuffer,
  fetchRegistryIndex,
  resolveRegistryIndexUrl
} from "./registry-source.js";
import type { ModuleCatalogPublicKey } from "./catalog-signing.js";
import { stageModuleDir, stagingDirFor } from "./stage.js";

export type ModuleDownloadErrorCode =
  | "index-unavailable"
  | "index-unverified"
  | "module-not-found"
  | "download-failed"
  | "integrity-mismatch"
  | "extract-failed"
  | "manifest-invalid"
  | "version-mismatch";

export class ModuleDownloadError extends Error {
  constructor(
    readonly code: ModuleDownloadErrorCode,
    message: string,
    /**
     * #1319: SHA-256 of the exact catalog bytes this failure was decided against. Set only
     * for "index-unverified" — i.e. the catalog WAS fetched but could not be authenticated —
     * so the admin has something concrete to review and accept. Never set when the catalog
     * could not be fetched at all, because there are no bytes to identify.
     */
    readonly catalogDigestSha256?: string
  ) {
    super(message);
    this.name = "ModuleDownloadError";
  }
}

export interface DownloadAndStageOptions {
  readonly moduleId: string;
  /** Pin a previousVersions entry; omit for the current version. */
  readonly version?: string;
  readonly modulesDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  /**
   * #1319: the admin's deliberate acceptance of ONE exact catalog, as the SHA-256 hex digest
   * of its bytes. Waives the signature requirement for that catalog and nothing else; a
   * digest that does not match what was just fetched is refused, not honoured.
   */
  readonly acceptedCatalogDigestSha256?: string;
  /** Test-only trusted-key injection, forwarded to fetchRegistryIndex. */
  readonly trustedKeys?: readonly ModuleCatalogPublicKey[];
}

export interface DownloadAndStageResult {
  readonly moduleId: string;
  readonly version: string;
  readonly sha256: string;
  readonly packageHash: string;
}

export async function downloadAndStageModule(
  options: DownloadAndStageOptions
): Promise<DownloadAndStageResult> {
  // #1319: the catalog is always fetched here. There is deliberately no way to hand one in —
  // a caller-supplied catalog would arrive with no signature result attached, which would let
  // an unauthenticated list drive the install and defeat the whole feature.
  const fetched = await fetchRegistryIndex({
    env: options.env,
    fetchFn: options.fetchFn,
    trustedKeys: options.trustedKeys
  });
  if (!fetched.index) {
    throw new ModuleDownloadError("index-unavailable", fetched.errors.join("; "));
  }
  // #1319: authenticate BEFORE anything is downloaded, extracted or written, so a catalog we
  // cannot vouch for never reaches the filesystem. An acceptance is matched against the digest
  // of what was just fetched, so a catalog that changed since the admin reviewed it is blocked
  // again and the NEW digest is reported for a fresh decision.
  if (fetched.verification !== "verified") {
    const digest = fetched.digestSha256 ?? undefined;
    if (
      options.acceptedCatalogDigestSha256 === undefined ||
      digest !== options.acceptedCatalogDigestSha256
    ) {
      throw new ModuleDownloadError(
        "index-unverified",
        "Moss could not confirm this module list came from us, so it will not install from it.",
        digest
      );
    }
  }
  const index = fetched.index;
  const resolved = resolveRegistryArtifact(index, options.moduleId, options.version);
  if (!resolved) {
    throw new ModuleDownloadError(
      "module-not-found",
      `module ${options.moduleId}${options.version ? `@${options.version}` : ""} is not in the registry index`
    );
  }
  const { ref } = resolved;
  if (ref.sizeBytes > ARTIFACT_MAX_BYTES) {
    throw new ModuleDownloadError(
      "integrity-mismatch",
      "declared artifact size exceeds the 50 MiB cap"
    );
  }
  // artifact is schema-validated to a bare filename → resolving it against the index
  // URL can only land inside the same release download path.
  const artifactUrl = new URL(ref.artifact, resolveRegistryIndexUrl(options.env)).toString();
  let tarballBytes: Buffer;
  try {
    tarballBytes = await downloadArtifactBuffer({
      url: artifactUrl,
      expectedSha256: ref.sha256,
      expectedSizeBytes: ref.sizeBytes,
      fetchFn: createRegistryFetch(options.env, options.fetchFn)
    });
  } catch (error) {
    const message = String(error);
    throw new ModuleDownloadError(
      /sha256|size/.test(message) ? "integrity-mismatch" : "download-failed",
      message
    );
  }
  mkdirSync(options.modulesDir, { recursive: true });
  const stagingDir = stagingDirFor(options.modulesDir, options.moduleId);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  try {
    const tarballPath = join(stagingDir, ".artifact.tgz");
    writeFileSync(tarballPath, tarballBytes);
    try {
      await safeExtractModuleTarball(tarballPath, stagingDir);
    } catch (error) {
      throw new ModuleDownloadError("extract-failed", String(error));
    }
    rmSync(tarballPath);
    const rawManifest: unknown = JSON.parse(
      readFileSync(join(stagingDir, "jarvis.module.json"), "utf8")
    );
    const validation = validateExternalModuleManifest(rawManifest, options.moduleId);
    if (!validation.ok) {
      throw new ModuleDownloadError("manifest-invalid", validation.errors.join("; "));
    }
    if (validation.manifest.version !== ref.version) {
      throw new ModuleDownloadError(
        "version-mismatch",
        `manifest version ${validation.manifest.version} != index version ${ref.version}`
      );
    }
    // Worker bundles are CJS. Pin their package boundary so a parent app's
    // `"type": "module"` cannot reinterpret dist/worker.js as ESM.
    writeFileSync(join(stagingDir, "package.json"), '{"type":"commonjs"}\n');
    // Hash the staged tree NOW — this is the packageHash the reconcile will trust.
    const packageHash = hashExternalPackage(stagingDir);
    stageModuleDir(stagingDir, options.modulesDir, options.moduleId);
    return { moduleId: options.moduleId, version: ref.version, sha256: ref.sha256, packageHash };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (error instanceof ModuleDownloadError) throw error;
    throw new ModuleDownloadError("extract-failed", String(error));
  }
}
