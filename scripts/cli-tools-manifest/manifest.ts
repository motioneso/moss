// Manifest shape, validation and ordering rules for the signed CLI tools manifest (#2689).
// Spec: docs/superpowers/specs/2026-09-25-cli-tools-auto-update.md section 4.1.

export const CLI_TOOLS_MANIFEST_KIND = "cli-tools";
export const CLI_TOOLS_FORMAT_VERSION = 1;

export type PackageRole = "cli" | "chat-adapter";
export type ProvenanceState = "attested" | "none";

export interface ManifestPackage {
  readonly role: PackageRole;
  readonly pkg: string;
  readonly version: string;
  readonly lockfile: string;
  readonly lockfileSha256: string;
  readonly provenance: ProvenanceState;
}

export interface ManifestToolset {
  readonly packages: readonly ManifestPackage[];
  readonly minMossVersion: string;
}

export interface CliToolsManifest {
  readonly kind: typeof CLI_TOOLS_MANIFEST_KIND;
  readonly formatVersion: typeof CLI_TOOLS_FORMAT_VERSION;
  readonly issuedAt: string;
  readonly sequence: number;
  /** Packages that have ever carried provenance. Only ever grows. */
  readonly provenanceHistory: Readonly<Record<string, { readonly since: string }>>;
  readonly toolsets: Readonly<Record<string, ManifestToolset>>;
}

export interface ManifestValidation {
  readonly manifest: CliToolsManifest | null;
  readonly errors: readonly string[];
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCKFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for a plain x.y.z version with no prerelease tag. */
export function isStableVersion(version: string): boolean {
  const m = SEMVER_RE.exec(version);
  return m !== null && m[4] === undefined;
}

/** Numeric x.y.z comparison. Throws on anything that is not a plain semver. */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) throw new Error(`not a semver: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Validates untrusted JSON. A module registry index fails here on `kind`. */
export function validateCliToolsManifest(raw: unknown): ManifestValidation {
  const fail = (msg: string): ManifestValidation => ({ manifest: null, errors: [msg] });
  if (!isRecord(raw)) return fail("manifest must be a JSON object");
  if (raw.kind !== CLI_TOOLS_MANIFEST_KIND)
    return fail(`kind must be "${CLI_TOOLS_MANIFEST_KIND}"`);
  if (raw.formatVersion !== CLI_TOOLS_FORMAT_VERSION) return fail("unsupported formatVersion");
  if (typeof raw.issuedAt !== "string" || Number.isNaN(Date.parse(raw.issuedAt))) {
    return fail("missing or invalid issuedAt");
  }
  if (!Number.isInteger(raw.sequence) || (raw.sequence as number) < 1) {
    return fail("sequence must be a positive integer");
  }
  if (!isRecord(raw.provenanceHistory)) return fail("provenanceHistory is required");
  for (const [pkg, entry] of Object.entries(raw.provenanceHistory)) {
    if (!isRecord(entry) || typeof entry.since !== "string" || !SEMVER_RE.test(entry.since)) {
      return fail(`provenanceHistory entry for ${pkg} is invalid`);
    }
  }
  if (!isRecord(raw.toolsets)) return fail("toolsets must be an object");
  const errors: string[] = [];
  for (const [name, toolset] of Object.entries(raw.toolsets)) {
    if (!isRecord(toolset) || !Array.isArray(toolset.packages) || toolset.packages.length === 0) {
      errors.push(`toolset ${name}: packages must be a non-empty array`);
      continue;
    }
    if (typeof toolset.minMossVersion !== "string" || toolset.minMossVersion === "") {
      errors.push(`toolset ${name}: minMossVersion is required`);
    }
    for (const [i, p] of toolset.packages.entries()) {
      const at = `toolset ${name} package ${i}`;
      if (!isRecord(p)) {
        errors.push(`${at}: must be an object`);
        continue;
      }
      if (p.role !== "cli" && p.role !== "chat-adapter") errors.push(`${at}: invalid role`);
      if (typeof p.pkg !== "string" || p.pkg === "") errors.push(`${at}: pkg is required`);
      if (typeof p.version !== "string" || !isStableVersion(p.version)) {
        errors.push(`${at}: version must be an exact stable semver`);
      }
      if (typeof p.lockfile !== "string" || !LOCKFILE_NAME_RE.test(p.lockfile)) {
        errors.push(`${at}: lockfile must be a plain file name`);
      }
      if (typeof p.lockfileSha256 !== "string" || !SHA256_RE.test(p.lockfileSha256)) {
        errors.push(`${at}: lockfileSha256 must be 64 hex chars`);
      }
      if (p.provenance !== "attested" && p.provenance !== "none") {
        errors.push(`${at}: provenance must be "attested" or "none"`);
      }
    }
  }
  if (errors.length > 0) return { manifest: null, errors };
  return { manifest: raw as unknown as CliToolsManifest, errors: [] };
}

/** The next sequence number. `previous` is null only for the very first publish. */
export function nextSequence(previous: CliToolsManifest | null): number {
  return previous === null ? 1 : previous.sequence + 1;
}

/** Bytes that get signed and uploaded. Consumers verify the signature over exactly these. */
export function manifestBytes(manifest: CliToolsManifest): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
