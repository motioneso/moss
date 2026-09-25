/**
 * #2689: the signed CLI tools manifest (spec 2026-09-25 section 4.1).
 *
 * The publisher writes it; instances (slice 4) fetch it, verify the signature, then parse it here.
 * The parser never throws on untrusted input.
 */

import type { CliToolRole, CliToolsetId } from "./toolsets.js";

export const CLI_TOOLS_MANIFEST_KIND = "cli-tools";
export const CLI_TOOLS_MANIFEST_FORMAT_VERSION = 1;
export const CLI_TOOLS_MANIFEST_FILENAME = "cli-tools.json";
export const CLI_TOOLS_RELEASE_TAG = "cli-tools";

export interface CliToolsManifestPackage {
  readonly role: CliToolRole;
  readonly pkg: string;
  readonly version: string;
  /** Release asset name of this package's npm lockfile. */
  readonly lockfile: string;
  /** Lowercase hex sha256 of the lockfile asset bytes. */
  readonly lockfileSha256: string;
  /** "verified" when the top-level package carries a provenance attestation that passed. */
  readonly provenance: "verified" | "none";
}

export interface CliToolsManifestToolset {
  readonly packages: readonly CliToolsManifestPackage[];
  readonly minMossVersion?: string;
}

export interface CliToolsManifest {
  readonly kind: typeof CLI_TOOLS_MANIFEST_KIND;
  readonly formatVersion: typeof CLI_TOOLS_MANIFEST_FORMAT_VERSION;
  readonly issuedAt: string;
  /** Only ever increases, so an old signed manifest cannot be replayed. */
  readonly sequence: number;
  readonly toolsets: Partial<Record<CliToolsetId, CliToolsManifestToolset>>;
}

const TOOLSET_IDS: readonly string[] = ["anthropic", "openai-compatible", "google"];
const ROLES: readonly string[] = ["cli", "chat-adapter"];
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PKG_RE = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;
const LOCKFILE_RE = /^[a-z0-9-]+-(?:cli|adapter)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.json$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Release asset name for one package's lockfile, e.g. `anthropic-cli-2.1.290.json`. */
export function lockfileAssetName(
  toolset: CliToolsetId,
  role: CliToolRole,
  version: string
): string {
  return `${toolset}-${role === "cli" ? "cli" : "adapter"}-${version}.json`;
}

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: CliToolsManifest }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePackage(value: unknown, where: string): CliToolsManifestPackage | string {
  if (!isRecord(value)) return `${where} is not an object`;
  const { role, pkg, version, lockfile, lockfileSha256, provenance } = value;
  if (typeof role !== "string" || !ROLES.includes(role)) return `${where}.role is invalid`;
  if (typeof pkg !== "string" || !PKG_RE.test(pkg)) return `${where}.pkg is invalid`;
  if (typeof version !== "string" || !EXACT_SEMVER_RE.test(version)) {
    return `${where}.version is not an exact version`;
  }
  if (typeof lockfile !== "string" || !LOCKFILE_RE.test(lockfile)) {
    return `${where}.lockfile is not a valid asset name`;
  }
  if (typeof lockfileSha256 !== "string" || !SHA256_HEX_RE.test(lockfileSha256)) {
    return `${where}.lockfileSha256 is not a sha256`;
  }
  if (provenance !== "verified" && provenance !== "none") {
    return `${where}.provenance is invalid`;
  }
  return { role: role as CliToolRole, pkg, version, lockfile, lockfileSha256, provenance };
}

export function parseCliToolsManifest(value: unknown): ParseManifestResult {
  if (!isRecord(value)) return { ok: false, reason: "manifest is not an object" };
  if (value.kind !== CLI_TOOLS_MANIFEST_KIND) return { ok: false, reason: "wrong kind" };
  if (value.formatVersion !== CLI_TOOLS_MANIFEST_FORMAT_VERSION) {
    return { ok: false, reason: "unsupported formatVersion" };
  }
  if (typeof value.issuedAt !== "string" || Number.isNaN(Date.parse(value.issuedAt))) {
    return { ok: false, reason: "issuedAt is not a timestamp" };
  }
  const sequence = value.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    return { ok: false, reason: "sequence is not a positive integer" };
  }
  if (!isRecord(value.toolsets)) return { ok: false, reason: "toolsets is not an object" };

  const toolsets: Partial<Record<CliToolsetId, CliToolsManifestToolset>> = {};
  for (const [id, raw] of Object.entries(value.toolsets)) {
    if (!TOOLSET_IDS.includes(id)) return { ok: false, reason: `unknown toolset ${id}` };
    if (!isRecord(raw) || !Array.isArray(raw.packages) || raw.packages.length === 0) {
      return { ok: false, reason: `toolset ${id} has no packages` };
    }
    const packages: CliToolsManifestPackage[] = [];
    for (const [index, entry] of raw.packages.entries()) {
      const parsed = parsePackage(entry, `${id}.packages[${index}]`);
      if (typeof parsed === "string") return { ok: false, reason: parsed };
      packages.push(parsed);
    }
    if (packages.filter((entry) => entry.role === "cli").length !== 1) {
      return { ok: false, reason: `toolset ${id} must have exactly one cli package` };
    }
    const minMossVersion = raw.minMossVersion;
    if (
      minMossVersion !== undefined &&
      (typeof minMossVersion !== "string" || !EXACT_SEMVER_RE.test(minMossVersion))
    ) {
      return { ok: false, reason: `toolset ${id} minMossVersion is invalid` };
    }
    toolsets[id as CliToolsetId] = minMossVersion ? { packages, minMossVersion } : { packages };
  }

  return {
    ok: true,
    manifest: {
      kind: CLI_TOOLS_MANIFEST_KIND,
      formatVersion: CLI_TOOLS_MANIFEST_FORMAT_VERSION,
      issuedAt: value.issuedAt,
      sequence,
      toolsets
    }
  };
}
