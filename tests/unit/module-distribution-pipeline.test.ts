import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";
import { afterAll, describe, expect, it } from "vitest";

import {
  downloadAndStageModule,
  fetchRegistryIndex,
  REGISTRY_INDEX_URL,
  REGISTRY_SIGNATURE_MAX_BYTES,
  resolveRegistryIndexUrl,
  signCatalogBytes,
  type ModuleCatalogPublicKey,
  type ModuleRegistryIndex
} from "../../packages/module-registry/src/node.js";

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const manifest = {
  schemaVersion: 1,
  id: "demo-module",
  name: "Demo Module",
  version: "1.2.0",
  publisher: "Jarvis Labs",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" }
};

/** Build a real module tarball and the index entry pointing at it. */
async function makeFixture(overrides?: { manifestVersion?: string }): Promise<{
  index: ModuleRegistryIndex;
  tarballBytes: Buffer;
}> {
  const src = tmp("pipe-src-");
  writeFileSync(
    join(src, "jarvis.module.json"),
    JSON.stringify({ ...manifest, version: overrides?.manifestVersion ?? manifest.version })
  );
  mkdirSync(join(src, "dist"));
  writeFileSync(join(src, "dist", "worker.js"), "// w");
  const tarball = join(tmp("pipe-tar-"), "demo-module-1.2.0.tgz");
  await tar.create({ gzip: true, portable: true, cwd: src, file: tarball }, [
    "jarvis.module.json",
    "dist"
  ]);
  const tarballBytes = readFileSync(tarball);
  return {
    tarballBytes,
    index: {
      schemaVersion: 1,
      generatedAt: "2026-07-12T00:00:00.000Z",
      modules: [
        {
          id: "demo-module",
          name: "Demo Module",
          description: null,
          version: "1.2.0",
          artifact: "demo-module-1.2.0.tgz",
          sha256: createHash("sha256").update(tarballBytes).digest("hex"),
          sizeBytes: tarballBytes.length,
          requiresCore: ">=0.0.0",
          capabilities: { permissions: [], fetchHosts: [], tools: [], ownsTables: [] },
          previousVersions: []
        }
      ]
    }
  };
}

/** Fake fetch serving the index and the tarball, standing in for the release URL. */
const fakeFetch =
  (index: ModuleRegistryIndex, tarballBytes: Buffer): typeof fetch =>
  async (input) => {
    const url = String(input);
    if (url.endsWith("/index.json")) return new Response(JSON.stringify(index), { status: 200 });
    if (url.endsWith(".tgz")) return new Response(new Uint8Array(tarballBytes), { status: 200 });
    return new Response("not found", { status: 404 });
  };

const ephemeralKeypair = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});
const TEST_KEY_ID = "test-catalog-key";
const TEST_TRUSTED_KEYS: readonly ModuleCatalogPublicKey[] = [
  { keyId: TEST_KEY_ID, publicKeyPem: ephemeralKeypair.publicKey }
];

/** Fake fetch additionally serving a signature over the exact served index bytes. */
const fakeFetchSigned = (
  index: ModuleRegistryIndex,
  tarballBytes: Buffer,
  options?: { readonly signatureOverride?: unknown; readonly indexBytesOverride?: Buffer }
): typeof fetch => {
  const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
  const signature =
    options?.signatureOverride ??
    signCatalogBytes(indexBytes, ephemeralKeypair.privateKey, TEST_KEY_ID);
  const servedIndexBytes = options?.indexBytesOverride ?? indexBytes;
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/index.json.sig")) {
      return new Response(JSON.stringify(signature), { status: 200 });
    }
    if (url.endsWith("/index.json"))
      return new Response(new Uint8Array(servedIndexBytes), { status: 200 });
    if (url.endsWith(".tgz")) return new Response(new Uint8Array(tarballBytes), { status: 200 });
    return new Response("not found", { status: 404 });
  };
};

describe("resolveRegistryIndexUrl (#964)", () => {
  it("defaults to the pinned release URL", () => {
    expect(resolveRegistryIndexUrl({} as NodeJS.ProcessEnv)).toBe(REGISTRY_INDEX_URL);
  });
  it("honors JARVIS_MODULE_REGISTRY_URL outside production", () => {
    const env = {
      JARVIS_MODULE_REGISTRY_URL: "http://127.0.0.1:9/index.json"
    } as NodeJS.ProcessEnv;
    expect(resolveRegistryIndexUrl(env)).toBe("http://127.0.0.1:9/index.json");
  });
  it("REFUSES the override in production", () => {
    const env = {
      NODE_ENV: "production",
      JARVIS_MODULE_REGISTRY_URL: "http://127.0.0.1:9/index.json"
    } as NodeJS.ProcessEnv;
    expect(() => resolveRegistryIndexUrl(env)).toThrow(/test-only/);
  });
});

describe("fetchRegistryIndex (#964)", () => {
  it("returns the validated index", async () => {
    const { index, tarballBytes } = await makeFixture();
    const result = await fetchRegistryIndex({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetch(index, tarballBytes)
    });
    expect(result.index?.modules[0]?.id).toBe("demo-module");
  });
  it("fails closed on an oversized index", async () => {
    const big: typeof fetch = async () =>
      new Response("x".repeat(1024 * 1024 + 1), { status: 200 });
    const result = await fetchRegistryIndex({ env: {} as NodeJS.ProcessEnv, fetchFn: big });
    expect(result.index).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("fails closed on a non-200 response", async () => {
    const nope: typeof fetch = async () => new Response("gone", { status: 404 });
    const result = await fetchRegistryIndex({ env: {} as NodeJS.ProcessEnv, fetchFn: nope });
    expect(result.index).toBeNull();
    expect(result.verification).toBe("unavailable");
    expect(result.digestSha256).toBeNull();
  });

  it("verifies a correctly signed index over the exact served bytes", async () => {
    const { index, tarballBytes } = await makeFixture();
    const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
    const result = await fetchRegistryIndex({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetchSigned(index, tarballBytes),
      trustedKeys: TEST_TRUSTED_KEYS
    });
    expect(result.index?.modules[0]?.id).toBe("demo-module");
    expect(result.verification).toBe("verified");
    expect(result.digestSha256).toBe(createHash("sha256").update(indexBytes).digest("hex"));
    expect(result.failureReason).toBeNull();
  });

  it("is unverified with signature-fetch-failed when no .sig route exists, but index still parses", async () => {
    const { index, tarballBytes } = await makeFixture();
    const result = await fetchRegistryIndex({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetch(index, tarballBytes),
      trustedKeys: TEST_TRUSTED_KEYS
    });
    expect(result.index?.modules[0]?.id).toBe("demo-module");
    expect(result.verification).toBe("unverified");
    expect(result.failureReason).toBe("signature-fetch-failed");
  });

  it("is unverified with signature-mismatch when index bytes are tampered under a stale signature", async () => {
    const { index, tarballBytes } = await makeFixture();
    const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
    const staleSignature = signCatalogBytes(indexBytes, ephemeralKeypair.privateKey, TEST_KEY_ID);
    const tamperedIndex = { ...index, modules: [...index.modules] };
    const tamperedBytes = Buffer.from(JSON.stringify(tamperedIndex) + " ", "utf8");
    const result = await fetchRegistryIndex({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetchSigned(index, tarballBytes, {
        signatureOverride: staleSignature,
        indexBytesOverride: tamperedBytes
      }),
      trustedKeys: TEST_TRUSTED_KEYS
    });
    expect(result.verification).toBe("unverified");
    expect(result.failureReason).toBe("signature-mismatch");
  });

  it("is unverified with signature-unknown-key when the signature names an untrusted key", async () => {
    const { index, tarballBytes } = await makeFixture();
    const result = await fetchRegistryIndex({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetchSigned(index, tarballBytes),
      trustedKeys: []
    });
    expect(result.verification).toBe("unverified");
    expect(result.failureReason).toBe("signature-unknown-key");
  });

  it("is unverified with signature-too-large when the signature body exceeds the cap", async () => {
    const { index, tarballBytes } = await makeFixture();
    const oversizeSignature = { padding: "x".repeat(REGISTRY_SIGNATURE_MAX_BYTES + 1) };
    const result = await fetchRegistryIndex({
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetchSigned(index, tarballBytes, { signatureOverride: oversizeSignature }),
      trustedKeys: TEST_TRUSTED_KEYS
    });
    expect(result.verification).toBe("unverified");
    expect(result.failureReason).toBe("signature-too-large");
  });
});

describe("downloadAndStageModule (#964)", () => {
  it("stages a verified module and returns its package hash", async () => {
    const { index, tarballBytes } = await makeFixture();
    const modulesDir = tmp("pipe-mods-");
    const result = await downloadAndStageModule({
      moduleId: "demo-module",
      modulesDir,
      env: {} as NodeJS.ProcessEnv,
      fetchFn: fakeFetch(index, tarballBytes)
    });
    expect(result.version).toBe("1.2.0");
    expect(result.packageHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(existsSync(join(modulesDir, "demo-module", "jarvis.module.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(modulesDir, "demo-module", "package.json"), "utf8"))
    ).toEqual({ type: "commonjs" });
    expect(existsSync(join(modulesDir, ".staging-demo-module"))).toBe(false);
  });

  it("rejects on sha256 mismatch without touching the modules dir", async () => {
    const { index, tarballBytes } = await makeFixture();
    const tampered = {
      ...index,
      modules: [{ ...index.modules[0]!, sha256: "b".repeat(64) }]
    };
    const modulesDir = tmp("pipe-mods-");
    await expect(
      downloadAndStageModule({
        moduleId: "demo-module",
        modulesDir,
        env: {} as NodeJS.ProcessEnv,
        fetchFn: fakeFetch(tampered, tarballBytes)
      })
    ).rejects.toMatchObject({ code: "integrity-mismatch" });
    expect(existsSync(join(modulesDir, "demo-module"))).toBe(false);
  });

  it("rejects when the inner manifest version disagrees with the index", async () => {
    const { tarballBytes } = await makeFixture({ manifestVersion: "9.9.9" });
    // Index advertises 1.2.0 but must carry the REAL sha/size of the 9.9.9 tarball so
    // integrity passes and the version check is what trips.
    const { index } = await makeFixture();
    const lying = {
      ...index,
      modules: [
        {
          ...index.modules[0]!,
          sha256: createHash("sha256").update(tarballBytes).digest("hex"),
          sizeBytes: tarballBytes.length
        }
      ]
    };
    await expect(
      downloadAndStageModule({
        moduleId: "demo-module",
        modulesDir: tmp("pipe-mods-"),
        env: {} as NodeJS.ProcessEnv,
        fetchFn: fakeFetch(lying, tarballBytes)
      })
    ).rejects.toMatchObject({ code: "version-mismatch" });
  });

  it("rejects an unknown module id", async () => {
    const { index, tarballBytes } = await makeFixture();
    await expect(
      downloadAndStageModule({
        moduleId: "nope",
        modulesDir: tmp("pipe-mods-"),
        env: {} as NodeJS.ProcessEnv,
        fetchFn: fakeFetch(index, tarballBytes)
      })
    ).rejects.toMatchObject({ code: "module-not-found" });
  });
});
