// #1319: Ed25519 signing/verification for the published module catalog. One key signs the
// whole catalog (index.json); the catalog's existing per-artifact sha256+size then authenticate
// every artifact transitively (steelman of the rejected per-module-signature fork: see the plan).
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { resolveMossEnv } from "@moss/db";

export const CATALOG_SIGNATURE_FORMAT_VERSION = 1;

export interface ModuleCatalogSignature {
  readonly formatVersion: 1;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signatureBase64: string;
}

export interface ModuleCatalogPublicKey {
  readonly keyId: string;
  readonly publicKeyPem: string; // SPKI PEM
}

/**
 * The keyring the shipping binary trusts. Empty until Ben provisions the real production
 * keypair out-of-band (D8 — no agent generates or prints the private key). Reserved keyId for
 * that key: "moss-catalog-2026-a". Do not add a placeholder entry here; tests that need a
 * non-empty keyring inject one via `trustedKeys` rather than mutating this constant.
 */
export const MODULE_CATALOG_PUBLIC_KEYS: readonly ModuleCatalogPublicKey[] = Object.freeze([]);

export function signCatalogBytes(
  bytes: Uint8Array,
  privateKeyPem: string,
  keyId: string
): ModuleCatalogSignature {
  const privateKey = createPrivateKey(privateKeyPem);
  const signatureBytes = sign(null, Buffer.from(bytes), privateKey);
  return {
    formatVersion: CATALOG_SIGNATURE_FORMAT_VERSION,
    algorithm: "ed25519",
    keyId,
    signatureBase64: signatureBytes.toString("base64")
  };
}

export type CatalogSignatureFailure = "malformed" | "unknown-key" | "signature-mismatch";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const ED25519_SIGNATURE_BYTES = 64;

/** Treats any structurally wrong document as "malformed"; never throws on untrusted input. */
export function verifyCatalogBytes(
  bytes: Uint8Array,
  signatureDocument: unknown,
  keys: readonly ModuleCatalogPublicKey[]
): { verified: true; keyId: string } | { verified: false; reason: CatalogSignatureFailure } {
  if (typeof signatureDocument !== "object" || signatureDocument === null) {
    return { verified: false, reason: "malformed" };
  }
  const doc = signatureDocument as Record<string, unknown>;
  if (doc.formatVersion !== CATALOG_SIGNATURE_FORMAT_VERSION) {
    return { verified: false, reason: "malformed" };
  }
  if (doc.algorithm !== "ed25519") {
    return { verified: false, reason: "malformed" };
  }
  if (typeof doc.keyId !== "string" || doc.keyId === "") {
    return { verified: false, reason: "malformed" };
  }
  if (typeof doc.signatureBase64 !== "string" || !BASE64_PATTERN.test(doc.signatureBase64)) {
    return { verified: false, reason: "malformed" };
  }
  const signatureBytes = Buffer.from(doc.signatureBase64, "base64");
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    return { verified: false, reason: "malformed" };
  }

  const key = keys.find((candidate) => candidate.keyId === doc.keyId);
  if (!key) {
    return { verified: false, reason: "unknown-key" };
  }

  try {
    const publicKey = createPublicKey(key.publicKeyPem);
    const matches = verify(null, Buffer.from(bytes), publicKey, signatureBytes);
    if (!matches) return { verified: false, reason: "signature-mismatch" };
    return { verified: true, keyId: key.keyId };
  } catch {
    return { verified: false, reason: "signature-mismatch" };
  }
}

/** Both env vars must be set together — a half-set pair is a misconfiguration, not "no key". */
export function resolveCatalogSigningKey(
  env: NodeJS.ProcessEnv
): { keyId: string; privateKeyPem: string } | null {
  const keyId = env.MOSS_MODULE_CATALOG_SIGNING_KEY_ID;
  const privateKeyPem = env.MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY;
  const keyIdSet = keyId !== undefined && keyId !== "";
  const privateKeySet = privateKeyPem !== undefined && privateKeyPem !== "";

  if (!keyIdSet && !privateKeySet) return null;
  if (!keyIdSet || !privateKeySet) {
    throw new Error(
      "MOSS_MODULE_CATALOG_SIGNING_KEY_ID and MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY must both be set, or neither"
    );
  }
  return { keyId, privateKeyPem };
}

/**
 * D6: the pinned keyring, plus — only when the registry-URL test override is active — a test
 * key from MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY. Refuses the test key in production itself
 * (independent of resolveRegistryIndexUrl — this function is reachable via `trustedKeys`
 * injection without the URL resolver ever running).
 */
export function resolveCatalogTrustedKeys(
  env: NodeJS.ProcessEnv
): readonly ModuleCatalogPublicKey[] {
  const testPublicKeyPem = env.MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY;
  const testKeySet = testPublicKeyPem !== undefined && testPublicKeyPem !== "";

  if (testKeySet && env.NODE_ENV === "production") {
    throw new Error("MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY is test-only and refused in production");
  }

  const registryUrlOverride = resolveMossEnv(env, "JARVIS_MODULE_REGISTRY_URL");
  const overrideActive = registryUrlOverride !== undefined && registryUrlOverride !== "";

  if (overrideActive && testKeySet) {
    return [...MODULE_CATALOG_PUBLIC_KEYS, { keyId: "test", publicKeyPem: testPublicKeyPem }];
  }
  return MODULE_CATALOG_PUBLIC_KEYS;
}
