// Loads the previous manifest, refuses rollbacks, assembles the next manifest and signs it.
// Runs only in the signing job, which never executes package code.
import { createPrivateKey, createPublicKey } from "node:crypto";

import {
  MODULE_CATALOG_PUBLIC_KEYS,
  signCatalogBytes,
  verifyCatalogBytes,
  type ModuleCatalogPublicKey,
  type ModuleCatalogSignature
} from "../../packages/module-registry/src/node.js";
import {
  CLI_TOOLS_FORMAT_VERSION,
  CLI_TOOLS_MANIFEST_KIND,
  compareVersions,
  manifestBytes,
  nextSequence,
  validateCliToolsManifest,
  type CliToolsManifest,
  type ManifestToolset
} from "./manifest.js";
import { extendHistory } from "./trust.js";

/**
 * Loads and verifies the published manifest. `null` bytes and a `null` signature together mean no
 * release exists yet (the first publish). Anything else that is not a valid signed manifest throws,
 * so a tampered or half-uploaded release stops the run instead of resetting the history.
 */
export function loadPreviousManifest(
  bytes: Uint8Array | null,
  signature: unknown | null,
  trustedKeys: readonly ModuleCatalogPublicKey[] = MODULE_CATALOG_PUBLIC_KEYS
): CliToolsManifest | null {
  if (bytes === null && signature === null) return null;
  if (bytes === null) throw new Error("published signature exists without a manifest");
  if (signature === null) throw new Error("published manifest has no signature");
  const check = verifyCatalogBytes(bytes, signature, trustedKeys);
  if (!check.verified) throw new Error(`published manifest signature is invalid: ${check.reason}`);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("published manifest is not valid JSON");
  }
  const result = validateCliToolsManifest(raw);
  if (result.manifest === null) {
    throw new Error(`published manifest is invalid: ${result.errors.join("; ")}`);
  }
  return result.manifest;
}

/** The version of `pkg` currently published in `toolset`, or null when it is not there. */
export function publishedVersion(
  previous: CliToolsManifest | null,
  toolset: string,
  pkg: string
): string | null {
  const found = previous?.toolsets[toolset]?.packages.find((p) => p.pkg === pkg);
  return found?.version ?? null;
}

/**
 * A requested version older than the published one is refused, so a manual run cannot roll a
 * toolset back under a higher sequence number. Equal is allowed (nothing to do upstream).
 */
export function assertNotRollback(
  previous: CliToolsManifest | null,
  toolset: string,
  pkg: string,
  requested: string
): void {
  const published = publishedVersion(previous, toolset, pkg);
  if (published !== null && compareVersions(requested, published) < 0) {
    throw new Error(
      `refusing rollback of ${pkg} in ${toolset}: ${requested} is older than published ${published}`
    );
  }
}

export interface AssembleInput {
  readonly previous: CliToolsManifest | null;
  /** Toolsets that changed this run. Every other toolset is carried over unchanged. */
  readonly updates: Readonly<Record<string, ManifestToolset>>;
  /** Packages that passed provenance at the versions published in `updates`. */
  readonly attested: readonly { readonly pkg: string; readonly version: string }[];
  readonly issuedAt: string;
}

export function assembleManifest(input: AssembleInput): CliToolsManifest {
  const { previous } = input;
  if (previous !== null && previous.provenanceHistory === undefined) {
    throw new Error("previous manifest has no provenance history; refusing to start it afresh");
  }
  const manifest: CliToolsManifest = {
    kind: CLI_TOOLS_MANIFEST_KIND,
    formatVersion: CLI_TOOLS_FORMAT_VERSION,
    issuedAt: input.issuedAt,
    sequence: nextSequence(previous),
    provenanceHistory: extendHistory(previous?.provenanceHistory ?? {}, input.attested),
    toolsets: { ...previous?.toolsets, ...input.updates }
  };
  const check = validateCliToolsManifest(JSON.parse(JSON.stringify(manifest)));
  if (check.manifest === null) {
    throw new Error(`assembled manifest is invalid: ${check.errors.join("; ")}`);
  }
  return manifest;
}

export interface SigningKey {
  readonly keyId: string;
  readonly privateKeyPem: string;
}

export interface SignedManifest {
  readonly bytes: Uint8Array;
  readonly signature: ModuleCatalogSignature;
}

/**
 * Signs the manifest and verifies it straight back. A key that is not pinned in the shipped
 * keyring is refused unless `allowUnpinnedKey` is set, which only the proof run uses, because
 * installs would reject such a signature anyway.
 */
export function signManifest(
  manifest: CliToolsManifest,
  key: SigningKey,
  options: { allowUnpinnedKey?: boolean } = {}
): SignedManifest {
  const pinned = MODULE_CATALOG_PUBLIC_KEYS.some((k) => k.keyId === key.keyId);
  if (!pinned && options.allowUnpinnedKey !== true) {
    throw new Error(`signing key "${key.keyId}" is not pinned in the shipped keyring`);
  }
  const bytes = manifestBytes(manifest);
  const signature = signCatalogBytes(bytes, key.privateKeyPem, key.keyId);
  const publicKeyPem = createPublicKey(createPrivateKey(key.privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyring: readonly ModuleCatalogPublicKey[] = pinned
    ? MODULE_CATALOG_PUBLIC_KEYS
    : [{ keyId: key.keyId, publicKeyPem }];
  const back = verifyCatalogBytes(bytes, signature, keyring);
  if (!back.verified) throw new Error(`fresh signature failed verification: ${back.reason}`);
  return { bytes, signature };
}
