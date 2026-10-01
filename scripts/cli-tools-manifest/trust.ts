// Release trust checks (spec 4.3): tarball checksums and npm provenance rules.
import { createHash } from "node:crypto";

export interface Attestations {
  readonly attestations?: readonly {
    readonly predicateType?: string;
    readonly bundle?: { readonly dsseEnvelope?: { readonly payload?: string } };
  }[];
}

export interface ProvenanceHistory {
  readonly [pkg: string]: { readonly since: string };
}

const SLSA_V1 = "https://slsa.dev/provenance/v1";

/** `sha512-<base64>` of the bytes, the same form npm writes as `integrity`. */
export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** Tarball bytes must match both the lockfile integrity and the registry's dist.integrity. */
export function checkTarball(
  bytes: Uint8Array,
  lockIntegrity: string,
  distIntegrity: string
): string[] {
  const actual = sha512Integrity(bytes);
  const errors: string[] = [];
  if (actual !== lockIntegrity) errors.push("tarball does not match the lockfile integrity");
  if (actual !== distIntegrity) errors.push("tarball does not match the registry dist.integrity");
  return errors;
}

interface ProvenanceFacts {
  readonly repo: string | null;
  readonly sha512Hex: string | null;
}

/** Reads source repository and subject digest from the SLSA provenance attestation, if any. */
export function readProvenance(doc: Attestations): ProvenanceFacts | null {
  const att = doc.attestations?.find((a) => a.predicateType === SLSA_V1);
  const payload = att?.bundle?.dsseEnvelope?.payload;
  if (payload === undefined) return null;
  try {
    const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      subject?: { digest?: { sha512?: string } }[];
      predicate?: {
        buildDefinition?: { externalParameters?: { workflow?: { repository?: string } } };
      };
    };
    const url = statement.predicate?.buildDefinition?.externalParameters?.workflow?.repository;
    const repo = url?.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") ?? null;
    return { repo, sha512Hex: statement.subject?.[0]?.digest?.sha512 ?? null };
  } catch {
    return { repo: null, sha512Hex: null };
  }
}

export interface ProvenanceVerdict {
  readonly ok: boolean;
  readonly provenance: "attested" | "none";
  readonly errors: readonly string[];
}

/**
 * - attested: source repo must match `expectedRepo` and the subject digest must match the tarball.
 * - absent but seen before (`history`): blocked, the mark of a release made outside the maker's CI.
 * - absent and never seen: allowed, recorded as "none".
 */
export function checkProvenance(input: {
  readonly pkg: string;
  readonly expectedRepo: string;
  readonly attestations: Attestations | null;
  readonly tarballIntegrity: string;
  readonly history: ProvenanceHistory;
}): ProvenanceVerdict {
  const facts = input.attestations === null ? null : readProvenance(input.attestations);
  if (facts === null) {
    if (input.history[input.pkg] !== undefined) {
      return {
        ok: false,
        provenance: "none",
        errors: [`${input.pkg} carried provenance before and now has none`]
      };
    }
    return { ok: true, provenance: "none", errors: [] };
  }
  const errors: string[] = [];
  if (facts.repo !== input.expectedRepo) {
    errors.push(
      `${input.pkg} provenance names ${facts.repo ?? "no repository"}, expected ${input.expectedRepo}`
    );
  }
  const want = Buffer.from(input.tarballIntegrity.replace(/^sha512-/, ""), "base64").toString(
    "hex"
  );
  if (facts.sha512Hex !== want) errors.push(`${input.pkg} provenance does not cover this tarball`);
  return { ok: errors.length === 0, provenance: "attested", errors };
}

/** History only grows: never removes an entry, records first-seen version. */
export function extendHistory(
  history: ProvenanceHistory,
  attested: readonly { readonly pkg: string; readonly version: string }[]
): ProvenanceHistory {
  const next: Record<string, { since: string }> = { ...history };
  for (const a of attested) next[a.pkg] ??= { since: a.version };
  return next;
}
