import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MODULE_CATALOG_PUBLIC_KEYS,
  signCatalogBytes
} from "../../packages/module-registry/src/node.js";
import {
  assembleManifest,
  assertNotRollback,
  loadPreviousManifest,
  signManifest
} from "../../scripts/cli-tools-manifest/sign-assemble.js";
import type {
  CliToolsManifest,
  ManifestToolset
} from "../../scripts/cli-tools-manifest/manifest.js";

const pair = generateKeyPairSync("ed25519");
const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const key = { keyId: "proof-key", privateKeyPem };

function toolset(version: string): ManifestToolset {
  return {
    minMossVersion: "0.2.0",
    packages: [
      {
        role: "cli",
        pkg: "@openai/codex",
        version,
        lockfile: `openai-compatible-cli-${version}.json`,
        lockfileSha256: "a".repeat(64),
        provenance: "attested"
      }
    ]
  };
}

function first(version = "1.0.0"): CliToolsManifest {
  return assembleManifest({
    previous: null,
    updates: { "openai-compatible": toolset(version) },
    attested: [{ pkg: "@openai/codex", version }],
    issuedAt: "2026-09-30T00:00:00Z"
  });
}

describe("assembling", () => {
  it("starts at sequence 1 and records first-seen provenance", () => {
    const m = first();
    expect(m.sequence).toBe(1);
    expect(m.provenanceHistory).toEqual({ "@openai/codex": { since: "1.0.0" } });
  });

  it("keeps untouched toolsets, bumps the sequence and keeps the first-seen version", () => {
    const prev = first("1.0.0");
    const next = assembleManifest({
      previous: prev,
      updates: {
        google: {
          ...toolset("3.0.0"),
          packages: [{ ...toolset("3.0.0").packages[0]!, pkg: "@google/gemini-cli" }]
        }
      },
      attested: [{ pkg: "@openai/codex", version: "2.0.0" }],
      issuedAt: "2026-10-01T00:00:00Z"
    });
    expect(next.sequence).toBe(2);
    expect(Object.keys(next.toolsets).sort()).toEqual(["google", "openai-compatible"]);
    expect(next.provenanceHistory["@openai/codex"]).toEqual({ since: "1.0.0" });
  });

  it("refuses to continue from a previous manifest that lost its history", () => {
    const broken = { ...first(), provenanceHistory: undefined } as unknown as CliToolsManifest;
    expect(() =>
      assembleManifest({
        previous: broken,
        updates: {},
        attested: [],
        issuedAt: "2026-10-01T00:00:00Z"
      })
    ).toThrow(/provenance history/);
  });
});

describe("signing", () => {
  it("round-trips through the previous-manifest loader", () => {
    const signed = signManifest(first(), key, { allowUnpinnedKey: true });
    const loaded = loadPreviousManifest(signed.bytes, signed.signature, [
      { keyId: key.keyId, publicKeyPem }
    ]);
    expect(loaded?.sequence).toBe(1);
  });

  it("refuses a key that is not pinned in the shipped keyring", () => {
    expect(() => signManifest(first(), key)).toThrow(/not pinned/);
  });

  it("refuses to let the production key sign in a proof run", () => {
    const pinnedId = MODULE_CATALOG_PUBLIC_KEYS[0]!.keyId;
    expect(() =>
      signManifest(first(), { keyId: pinnedId, privateKeyPem }, { allowUnpinnedKey: true })
    ).toThrow(/may not sign in a proof run/);
  });

  it("fails verification when a single byte changes", () => {
    const signed = signManifest(first(), key, { allowUnpinnedKey: true });
    const tampered = Buffer.from(signed.bytes);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 3) ^ 1, tampered.length - 3);
    expect(() =>
      loadPreviousManifest(tampered, signed.signature, [{ keyId: key.keyId, publicKeyPem }])
    ).toThrow(/signature is invalid/);
  });
});

describe("loading the published manifest", () => {
  it("treats no release as the first publish", () => {
    expect(loadPreviousManifest(null, null)).toBeNull();
  });

  it("refuses a published manifest with no signature", () => {
    const signed = signManifest(first(), key, { allowUnpinnedKey: true });
    expect(() => loadPreviousManifest(signed.bytes, null)).toThrow(/no signature/);
  });

  it("refuses a correctly signed manifest whose history is missing", () => {
    const { provenanceHistory: _dropped, ...rest } = first();
    const bytes = Buffer.from(JSON.stringify(rest), "utf8");
    const signed = signManifest(first(), key, { allowUnpinnedKey: true });
    // Re-sign the stripped document with the same key so only the history is wrong.
    const sig = signCatalogBytes(bytes, key.privateKeyPem, key.keyId);
    expect(signed.signature.keyId).toBe(key.keyId);
    expect(() => loadPreviousManifest(bytes, sig, [{ keyId: key.keyId, publicKeyPem }])).toThrow(
      /provenanceHistory is required/
    );
  });
});

describe("rollback refusal", () => {
  const prev = first("2.0.0");

  it("refuses an older version than the published one", () => {
    expect(() => assertNotRollback(prev, "openai-compatible", "@openai/codex", "1.9.9")).toThrow(
      /refusing rollback/
    );
  });

  it("allows the same or a newer version, and a package not yet published", () => {
    expect(() =>
      assertNotRollback(prev, "openai-compatible", "@openai/codex", "2.0.0")
    ).not.toThrow();
    expect(() =>
      assertNotRollback(prev, "openai-compatible", "@openai/codex", "2.0.1")
    ).not.toThrow();
    expect(() => assertNotRollback(prev, "google", "@google/gemini-cli", "0.1.0")).not.toThrow();
    expect(() => assertNotRollback(null, "google", "@google/gemini-cli", "0.1.0")).not.toThrow();
  });
});
