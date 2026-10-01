import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  fetchVerifiedCliToolsManifest,
  signCatalogBytes,
  manifestBytes,
  type CliToolsManifest
} from "../../packages/module-registry/src/node.js";

const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");
const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const lockBytes = Buffer.from('{"lockfileVersion":3}\n');
const lockSha = createHash("sha256").update(lockBytes).digest("hex");

function manifest(over: Partial<CliToolsManifest> = {}): CliToolsManifest {
  return {
    kind: "cli-tools",
    formatVersion: 1,
    issuedAt: "2026-09-30T00:00:00Z",
    sequence: 5,
    provenanceHistory: {},
    toolsets: {
      anthropic: {
        minMossVersion: "0.1.0",
        packages: [
          {
            role: "cli",
            pkg: "@anthropic-ai/claude-code",
            version: "2.1.290",
            lockfile: "anthropic-cli-2.1.290.json",
            lockfileSha256: lockSha,
            provenance: "attested"
          }
        ]
      }
    },
    ...over
  };
}

function fakeFetch(files: Record<string, Uint8Array | undefined>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const name = String(url).split("/").pop() as string;
    const body = files[name];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(Buffer.from(body));
  }) as typeof fetch;
}

function release(m: CliToolsManifest, signWith = privatePem, keyId = "k-a", lock = lockBytes) {
  const bytes = manifestBytes(m);
  const sig = signCatalogBytes(bytes, signWith, keyId);
  return {
    "cli-tools-manifest.json": bytes,
    "cli-tools-manifest.json.sig": Buffer.from(JSON.stringify(sig)),
    "anthropic-cli-2.1.290.json": lock
  };
}

const keys = [{ keyId: "k-a", publicKeyPem: publicPem }];
const base = { trustedKeys: keys, lastSequence: 4 } as const;

describe("fetchVerifiedCliToolsManifest", () => {
  it("accepts a correctly signed manifest and returns its lockfile bytes", async () => {
    const r = await fetchVerifiedCliToolsManifest({
      ...base,
      fetchFn: fakeFetch(release(manifest()))
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.sequence).toBe(5);
      expect(Buffer.from(r.lockfiles["anthropic-cli-2.1.290.json"]!).equals(lockBytes)).toBe(true);
    }
  });

  it("verifies against whichever pinned key signed it, with no key hardcoded", async () => {
    const two = [{ keyId: "k-b", publicKeyPem: publicPem }, ...keys.map((k) => ({ ...k }))];
    const r = await fetchVerifiedCliToolsManifest({
      trustedKeys: [two[0]!],
      lastSequence: 0,
      fetchFn: fakeFetch(release(manifest(), privatePem, "k-b"))
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a key the image does not hold", async () => {
    const r = await fetchVerifiedCliToolsManifest({
      ...base,
      fetchFn: fakeFetch(release(manifest(), otherPem, "k-unpinned"))
    });
    expect(r).toMatchObject({ ok: false, reason: "signature-unknown-key" });
  });

  it("rejects a signature made by a different private key under a pinned id", async () => {
    const r = await fetchVerifiedCliToolsManifest({
      ...base,
      fetchFn: fakeFetch(release(manifest(), otherPem, "k-a"))
    });
    expect(r).toMatchObject({ ok: false, reason: "signature-mismatch" });
  });

  it("rejects a manifest whose kind is not cli-tools, even when signed", async () => {
    const bad = { ...manifest(), kind: "modules" } as unknown as CliToolsManifest;
    const r = await fetchVerifiedCliToolsManifest({ ...base, fetchFn: fakeFetch(release(bad)) });
    expect(r).toMatchObject({ ok: false, reason: "manifest-invalid" });
  });

  it("rejects a sequence that is not newer than the last accepted one", async () => {
    for (const last of [5, 9]) {
      const r = await fetchVerifiedCliToolsManifest({
        trustedKeys: keys,
        lastSequence: last,
        fetchFn: fakeFetch(release(manifest()))
      });
      expect(r).toMatchObject({ ok: false, reason: "sequence-not-newer" });
    }
  });

  it("rejects a lockfile whose sha256 differs from the manifest", async () => {
    const r = await fetchVerifiedCliToolsManifest({
      ...base,
      fetchFn: fakeFetch(release(manifest(), privatePem, "k-a", Buffer.from("tampered")))
    });
    expect(r).toMatchObject({ ok: false, reason: "lockfile-mismatch" });
  });

  it("reports a fetch failure without throwing", async () => {
    const r = await fetchVerifiedCliToolsManifest({ ...base, fetchFn: fakeFetch({}) });
    expect(r).toMatchObject({ ok: false, reason: "fetch-failed" });
  });

  it("rejects an oversized manifest", async () => {
    const files = release(manifest());
    files["cli-tools-manifest.json"] = Buffer.alloc(2 * 1024 * 1024);
    const r = await fetchVerifiedCliToolsManifest({ ...base, fetchFn: fakeFetch(files) });
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
  });
});
