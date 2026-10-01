// Instance side of the signed CLI tools manifest (#2689 slice 4, spec 4.2).
// The fetch URL is fixed in code. Keys come from the caller, which passes the keyring built
// into the running image; nothing here names a key.
import { createHash } from "node:crypto";

import { createHostPinnedFetch } from "@moss/host-fetch";

import { verifyCatalogBytes, type ModuleCatalogPublicKey } from "./catalog-signing.js";
import { validateCliToolsManifest, type CliToolsManifest } from "./cli-tools-manifest.js";
import { REGISTRY_ALLOWED_HOSTS, REGISTRY_SIGNATURE_MAX_BYTES } from "./registry-source.js";

export const CLI_TOOLS_RELEASE_BASE =
  "https://github.com/motioneso/jarv1s/releases/download/cli-tools";
export const CLI_TOOLS_MANIFEST_FILE = "cli-tools-manifest.json";
export const CLI_TOOLS_SIGNATURE_FILE = "cli-tools-manifest.json.sig";
export const CLI_TOOLS_MANIFEST_MAX_BYTES = 1024 * 1024;
export const CLI_TOOLS_LOCKFILE_MAX_BYTES = 8 * 1024 * 1024;

export type CliToolsFetchFailure =
  | "fetch-failed"
  | "too-large"
  | "signature-malformed"
  | "signature-unknown-key"
  | "signature-mismatch"
  | "manifest-invalid"
  | "sequence-not-newer"
  | "lockfile-mismatch";

export type CliToolsFetchResult =
  | {
      readonly ok: true;
      readonly manifest: CliToolsManifest;
      readonly manifestBytes: Uint8Array;
      readonly keyId: string;
      /** Lockfile bytes by file name, each already checked against the manifest sha256. */
      readonly lockfiles: Readonly<Record<string, Uint8Array>>;
    }
  | { readonly ok: false; readonly reason: CliToolsFetchFailure };

export interface FetchVerifiedCliToolsManifestOptions {
  readonly trustedKeys: readonly ModuleCatalogPublicKey[];
  /** Highest sequence this instance has accepted. 0 when none. */
  readonly lastSequence: number;
  /** Only the lockfiles of these toolsets are downloaded. Default: all. */
  readonly toolsets?: readonly string[];
  readonly fetchFn?: typeof fetch;
}

class Failure extends Error {
  constructor(readonly reason: CliToolsFetchFailure) {
    super(reason);
  }
}

async function download(doFetch: typeof fetch, name: string, max: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await doFetch(`${CLI_TOOLS_RELEASE_BASE}/${name}`);
  } catch {
    throw new Failure("fetch-failed");
  }
  if (!res.ok) throw new Failure("fetch-failed");
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch {
    throw new Failure("fetch-failed");
  }
  if (buf.byteLength > max) throw new Failure("too-large");
  return new Uint8Array(buf);
}

/** Never throws. Every problem folds into `{ ok: false, reason }` and changes nothing. */
export async function fetchVerifiedCliToolsManifest(
  options: FetchVerifiedCliToolsManifestOptions
): Promise<CliToolsFetchResult> {
  const doFetch =
    options.fetchFn ??
    createHostPinnedFetch(REGISTRY_ALLOWED_HOSTS, {
      maxResponseBytes: CLI_TOOLS_LOCKFILE_MAX_BYTES
    });
  try {
    const bytes = await download(doFetch, CLI_TOOLS_MANIFEST_FILE, CLI_TOOLS_MANIFEST_MAX_BYTES);
    const sigBytes = await download(
      doFetch,
      CLI_TOOLS_SIGNATURE_FILE,
      REGISTRY_SIGNATURE_MAX_BYTES
    );

    let sigDoc: unknown;
    try {
      sigDoc = JSON.parse(Buffer.from(sigBytes).toString("utf8"));
    } catch {
      throw new Failure("signature-malformed");
    }
    const verdict = verifyCatalogBytes(bytes, sigDoc, options.trustedKeys);
    if (!verdict.verified) {
      throw new Failure(
        verdict.reason === "malformed"
          ? "signature-malformed"
          : verdict.reason === "unknown-key"
            ? "signature-unknown-key"
            : "signature-mismatch"
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new Failure("manifest-invalid");
    }
    const { manifest } = validateCliToolsManifest(raw);
    if (manifest === null) throw new Failure("manifest-invalid");
    if (manifest.sequence <= options.lastSequence) throw new Failure("sequence-not-newer");

    const lockfiles: Record<string, Uint8Array> = {};
    for (const [name, toolset] of Object.entries(manifest.toolsets)) {
      if (options.toolsets !== undefined && !options.toolsets.includes(name)) continue;
      for (const pkg of toolset.packages) {
        const lock = await download(doFetch, pkg.lockfile, CLI_TOOLS_LOCKFILE_MAX_BYTES);
        const sha = createHash("sha256").update(lock).digest("hex");
        if (sha !== pkg.lockfileSha256) throw new Failure("lockfile-mismatch");
        lockfiles[pkg.lockfile] = lock;
      }
    }
    return { ok: true, manifest, manifestBytes: bytes, keyId: verdict.keyId, lockfiles };
  } catch (e) {
    return { ok: false, reason: e instanceof Failure ? e.reason : "fetch-failed" };
  }
}
