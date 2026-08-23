// #964: where the registry lives and how we talk to it. The index URL and host list
// are HARDCODED — an env override exists for tests only and is refused outright in
// production so no runtime configuration can redirect module downloads.
import { createHash } from "node:crypto";

import { resolveMossEnv } from "@moss/db";
import { createHostPinnedFetch } from "@moss/host-fetch";

import {
  resolveCatalogTrustedKeys,
  verifyCatalogBytes,
  type ModuleCatalogPublicKey
} from "./catalog-signing.js";
import { validateRegistryIndex, type ModuleRegistryIndex } from "./index-schema.js";

export const REGISTRY_INDEX_URL =
  "https://github.com/motioneso/jarv1s/releases/download/modules/index.json";

// github.com serves the release URL; the two githubusercontent hosts are where GitHub
// redirects release-asset downloads.
export const REGISTRY_ALLOWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
] as const;

export const REGISTRY_INDEX_MAX_BYTES = 1024 * 1024;

export const REGISTRY_SIGNATURE_MAX_BYTES = 4 * 1024;

export type CatalogVerification = "verified" | "unverified" | "unavailable";

export type CatalogVerificationFailureReason =
  | "index-fetch-failed"
  | "index-too-large"
  | "index-invalid"
  | "signature-fetch-failed"
  | "signature-too-large"
  | "signature-malformed"
  | "signature-unknown-key"
  | "signature-mismatch";

export function resolveRegistryIndexUrl(env: NodeJS.ProcessEnv): string {
  const override = resolveMossEnv(env, "JARVIS_MODULE_REGISTRY_URL");
  if (override !== undefined && override !== "") {
    if (env.NODE_ENV === "production") {
      throw new Error("JARVIS_MODULE_REGISTRY_URL is test-only and refused in production");
    }
    return override;
  }
  return REGISTRY_INDEX_URL;
}

/**
 * The fetch used for all registry traffic. Default: host-pinned fetch locked to the
 * three GitHub hosts (SSRF/redirect containment + private-IP blocklist). When a
 * test override URL is active — impossible in production, resolveRegistryIndexUrl
 * throws there — we use plain fetch, because the mock registry sits on loopback,
 * which the host-pinned resolver correctly blocks.
 */
export function createRegistryFetch(env: NodeJS.ProcessEnv, fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) return fetchFn;
  const registryUrlOverride = resolveMossEnv(env, "JARVIS_MODULE_REGISTRY_URL");
  if (registryUrlOverride !== undefined && registryUrlOverride !== "") {
    if (env.NODE_ENV === "production") {
      throw new Error("JARVIS_MODULE_REGISTRY_URL is test-only and refused in production");
    }
    return fetch;
  }
  return createHostPinnedFetch(REGISTRY_ALLOWED_HOSTS, {
    maxResponseBytes: 50 * 1024 * 1024 + 1024
  });
}

export interface FetchRegistryIndexOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  readonly trustedKeys?: readonly ModuleCatalogPublicKey[];
}

export interface FetchRegistryIndexResult {
  readonly index: ModuleRegistryIndex | null;
  readonly verification: CatalogVerification;
  readonly digestSha256: string | null;
  readonly failureReason: CatalogVerificationFailureReason | null;
  readonly errors: string[];
}

/**
 * Verifies the fetched signature document against the exact index bytes. Any signature-side
 * problem (fetch, size, shape, unknown key, mismatch) folds to "unverified" with a reason —
 * never throws, so an unsigned or misconfigured registry still lists (unverified), it just
 * never lists as verified.
 */
async function verifyIndexSignature(
  indexBytes: Uint8Array,
  url: string,
  doFetch: typeof fetch,
  trustedKeys: readonly ModuleCatalogPublicKey[]
): Promise<{ verified: boolean; failureReason: CatalogVerificationFailureReason | null }> {
  let response: Response;
  try {
    response = await doFetch(`${url}.sig`);
  } catch {
    return { verified: false, failureReason: "signature-fetch-failed" };
  }
  if (!response.ok) return { verified: false, failureReason: "signature-fetch-failed" };

  let sigBytes: ArrayBuffer;
  try {
    sigBytes = await response.arrayBuffer();
  } catch {
    return { verified: false, failureReason: "signature-fetch-failed" };
  }
  if (sigBytes.byteLength > REGISTRY_SIGNATURE_MAX_BYTES) {
    return { verified: false, failureReason: "signature-too-large" };
  }

  let signatureDocument: unknown;
  try {
    signatureDocument = JSON.parse(Buffer.from(sigBytes).toString("utf8"));
  } catch {
    return { verified: false, failureReason: "signature-malformed" };
  }

  const result = verifyCatalogBytes(indexBytes, signatureDocument, trustedKeys);
  if (result.verified) return { verified: true, failureReason: null };
  if (result.reason === "malformed") return { verified: false, failureReason: "signature-malformed" };
  if (result.reason === "unknown-key") return { verified: false, failureReason: "signature-unknown-key" };
  return { verified: false, failureReason: "signature-mismatch" };
}

/** Never throws for remote/shape/signature problems — folds every failure into the result. */
export async function fetchRegistryIndex(
  options: FetchRegistryIndexOptions
): Promise<FetchRegistryIndexResult> {
  try {
    const url = resolveRegistryIndexUrl(options.env);
    const doFetch = createRegistryFetch(options.env, options.fetchFn);
    const response = await doFetch(url);
    if (!response.ok) {
      return {
        index: null,
        verification: "unavailable",
        digestSha256: null,
        failureReason: "index-fetch-failed",
        errors: [`registry index HTTP ${response.status}`]
      };
    }
    const indexBytes = new Uint8Array(await response.arrayBuffer());
    if (indexBytes.byteLength > REGISTRY_INDEX_MAX_BYTES) {
      return {
        index: null,
        verification: "unavailable",
        digestSha256: null,
        failureReason: "index-too-large",
        errors: ["registry index exceeds 1 MiB cap"]
      };
    }
    const digestSha256 = createHash("sha256").update(indexBytes).digest("hex");

    let parsed: unknown;
    let validated: { index: ModuleRegistryIndex | null; errors: readonly string[] };
    try {
      parsed = JSON.parse(Buffer.from(indexBytes).toString("utf8"));
      validated = validateRegistryIndex(parsed);
    } catch (error) {
      return {
        index: null,
        verification: "unavailable",
        digestSha256,
        failureReason: "index-invalid",
        errors: [`registry index unavailable: ${String(error)}`]
      };
    }
    if (!validated.index) {
      return {
        index: null,
        verification: "unavailable",
        digestSha256,
        failureReason: "index-invalid",
        errors: [...validated.errors]
      };
    }

    const trustedKeys = options.trustedKeys ?? resolveCatalogTrustedKeys(options.env);
    const signatureResult = await verifyIndexSignature(indexBytes, url, doFetch, trustedKeys);

    return {
      index: validated.index,
      verification: signatureResult.verified ? "verified" : "unverified",
      digestSha256,
      failureReason: signatureResult.verified ? null : signatureResult.failureReason,
      errors: [...validated.errors]
    };
  } catch (error) {
    return {
      index: null,
      verification: "unavailable",
      digestSha256: null,
      failureReason: "index-fetch-failed",
      errors: [`registry index unavailable: ${String(error)}`]
    };
  }
}

export interface DownloadArtifactOptions {
  readonly url: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
  readonly fetchFn: typeof fetch;
}

/**
 * Download an artifact into memory (≤50 MiB by schema cap — acceptable resident cost
 * for an admin-initiated action) and verify size + sha256 BEFORE anything reaches disk.
 */
export async function downloadArtifactBuffer(options: DownloadArtifactOptions): Promise<Buffer> {
  const response = await options.fetchFn(options.url);
  if (!response.ok) throw new Error(`artifact HTTP ${response.status}`);
  const cap = options.expectedSizeBytes;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const body = response.body;
  if (!body) throw new Error("artifact response has no body");
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    // Abort mid-stream the moment the payload exceeds what the index promised.
    if (received > cap) {
      await reader.cancel();
      throw new Error(`artifact exceeds declared size ${cap}`);
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length !== options.expectedSizeBytes) {
    throw new Error(`artifact size ${buffer.length} != declared ${options.expectedSizeBytes}`);
  }
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== options.expectedSha256) {
    throw new Error("artifact sha256 does not match the registry index");
  }
  return buffer;
}
