import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  resolveCatalogSigningKey,
  resolveCatalogTrustedKeys,
  signCatalogBytes,
  verifyCatalogBytes,
  type ModuleCatalogPublicKey
} from "../../packages/module-registry/src/node.js";

function makeKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

describe("signCatalogBytes / verifyCatalogBytes", () => {
  const { publicKeyPem, privateKeyPem } = makeKeyPair();
  const keyId = "test-key-a";
  const keys: readonly ModuleCatalogPublicKey[] = [{ keyId, publicKeyPem }];
  const bytes = new TextEncoder().encode('{"schemaVersion":1,"modules":[]}');

  it("round-trips: sign then verify with the matching key succeeds", () => {
    const signature = signCatalogBytes(bytes, privateKeyPem, keyId);
    const result = verifyCatalogBytes(bytes, signature, keys);
    expect(result).toEqual({ verified: true, keyId });
  });

  it("flips one byte in the signed content -> signature-mismatch", () => {
    const signature = signCatalogBytes(bytes, privateKeyPem, keyId);
    const tampered = new Uint8Array(bytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const result = verifyCatalogBytes(tampered, signature, keys);
    expect(result).toEqual({ verified: false, reason: "signature-mismatch" });
  });

  it("unknown keyId -> unknown-key; a two-key keyring accepts either key (rotation overlap)", () => {
    const signature = signCatalogBytes(bytes, privateKeyPem, keyId);

    const unknownKeyResult = verifyCatalogBytes(bytes, signature, []);
    expect(unknownKeyResult).toEqual({ verified: false, reason: "unknown-key" });

    const other = makeKeyPair();
    const otherKeyId = "test-key-b";
    const twoKeyRing: readonly ModuleCatalogPublicKey[] = [
      { keyId: otherKeyId, publicKeyPem: other.publicKeyPem },
      { keyId, publicKeyPem }
    ];
    const signedByOther = signCatalogBytes(bytes, other.privateKeyPem, otherKeyId);
    expect(verifyCatalogBytes(bytes, signature, twoKeyRing)).toEqual({ verified: true, keyId });
    expect(verifyCatalogBytes(bytes, signedByOther, twoKeyRing)).toEqual({
      verified: true,
      keyId: otherKeyId
    });
  });

  it("rejects malformed signature documents without throwing", () => {
    const cases: unknown[] = [
      null,
      "a string, not an object",
      42,
      { formatVersion: 2, algorithm: "ed25519", keyId, signatureBase64: "AAAA" },
      { formatVersion: 1, algorithm: "rsa", keyId, signatureBase64: "AAAA" },
      { formatVersion: 1, algorithm: "ed25519", keyId, signatureBase64: "not base64 !!!" },
      { formatVersion: 1, algorithm: "ed25519", keyId: "", signatureBase64: "AAAA" },
      { formatVersion: 1, algorithm: "ed25519", keyId, signatureBase64: "AAAA" } // wrong byte length
    ];
    for (const doc of cases) {
      expect(() => verifyCatalogBytes(bytes, doc, keys)).not.toThrow();
      const result = verifyCatalogBytes(bytes, doc, keys);
      expect(result).toEqual({ verified: false, reason: "malformed" });
    }
  });
});

describe("resolveCatalogSigningKey", () => {
  it("returns null when neither env var is set", () => {
    expect(resolveCatalogSigningKey({})).toBeNull();
  });

  it("returns the pair when both env vars are set", () => {
    const result = resolveCatalogSigningKey({
      MOSS_MODULE_CATALOG_SIGNING_KEY_ID: "moss-catalog-2026-a",
      MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    });
    expect(result).toEqual({
      keyId: "moss-catalog-2026-a",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
    });
  });

  it("throws when only the key id is set", () => {
    expect(() =>
      resolveCatalogSigningKey({ MOSS_MODULE_CATALOG_SIGNING_KEY_ID: "moss-catalog-2026-a" })
    ).toThrow();
  });

  it("throws when only the private key is set", () => {
    expect(() =>
      resolveCatalogSigningKey({ MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY: "pem" })
    ).toThrow();
  });
});

describe("resolveCatalogTrustedKeys", () => {
  it("returns only the pinned keyring when the URL override is not active and no test key is set", () => {
    expect(resolveCatalogTrustedKeys({})).toEqual([]);
  });

  it("adds the test key only when the URL override is active and the test key is set", () => {
    const withoutOverride = resolveCatalogTrustedKeys({
      MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY: "test-pem"
    });
    expect(withoutOverride).toEqual([]);

    const withOverride = resolveCatalogTrustedKeys({
      JARVIS_MODULE_REGISTRY_URL: "http://localhost:9999/index.json",
      MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY: "test-pem"
    });
    expect(withOverride).toEqual([{ keyId: "test", publicKeyPem: "test-pem" }]);
  });

  it("throws in production when the test key is set, with the URL override set", () => {
    expect(() =>
      resolveCatalogTrustedKeys({
        NODE_ENV: "production",
        JARVIS_MODULE_REGISTRY_URL: "http://localhost:9999/index.json",
        MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY: "test-pem"
      })
    ).toThrow();
  });

  it("throws in production when the test key is set, without the URL override set", () => {
    expect(() =>
      resolveCatalogTrustedKeys({
        NODE_ENV: "production",
        MOSS_MODULE_CATALOG_TEST_PUBLIC_KEY: "test-pem"
      })
    ).toThrow();
  });
});
