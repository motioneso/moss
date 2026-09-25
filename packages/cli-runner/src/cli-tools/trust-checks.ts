/**
 * #2689: the pure halves of the publisher's release trust checks (spec 2026-09-25 section 4.3).
 * Network and file access live in scripts/cli-tools/; everything here is data in, verdict out.
 */

const STABLE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export interface NpmPackument {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, { readonly deprecated?: unknown }>>;
}

function compareStable(a: string, b: string): number {
  const pa = STABLE_SEMVER_RE.exec(a)!.slice(1).map(Number);
  const pb = STABLE_SEMVER_RE.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

function isUsable(packument: NpmPackument, version: string): boolean {
  const meta = packument.versions?.[version];
  return STABLE_SEMVER_RE.test(version) && meta !== undefined && !meta.deprecated;
}

/**
 * The newest stable, non-deprecated version. Prefers the `latest` tag, so a maintenance release
 * on an old line never outranks it; falls back to the highest usable version when `latest` is
 * missing, a prerelease or deprecated. Unpublished versions are absent from `versions`.
 */
export function pickLatestStable(packument: NpmPackument): string | null {
  const tagged = packument["dist-tags"]?.latest;
  if (tagged && isUsable(packument, tagged)) return tagged;
  const usable = Object.keys(packument.versions ?? {}).filter((v) => isUsable(packument, v));
  if (usable.length === 0) return null;
  return usable.sort(compareStable).at(-1)!;
}

/** True when `version` exists, is stable and is not deprecated. */
export function isPublishableVersion(packument: NpmPackument, version: string): boolean {
  return isUsable(packument, version);
}

// ─── lockfiles ──────────────────────────────────────────────────────────────

export interface LockfileEntryMeta {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly os?: readonly string[];
}

export interface NpmLockfile {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockfileEntryMeta>>;
}

export interface InstallableEntry {
  readonly key: string;
  /** Registry package name (the alias target for aliased entries). */
  readonly name: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
}

function nameFromKey(key: string): string {
  const index = key.lastIndexOf("node_modules/");
  return index === -1 ? key : key.slice(index + "node_modules/".length);
}

/**
 * Every lockfile problem that blocks a toolset: a missing packages map, an entry without sha512,
 * or a required per-arch package that is no longer pulled in.
 */
export function lockfileProblems(
  lockfile: NpmLockfile,
  requiredPackages: readonly string[]
): string[] {
  const packages = lockfile.packages;
  if (!packages || Object.keys(packages).length <= 1) {
    return ["lockfile has no resolved packages"];
  }
  const problems: string[] = [];
  for (const [key, meta] of Object.entries(packages)) {
    if (key === "" || meta.link === true) continue;
    if (typeof meta.integrity !== "string" || !meta.integrity.startsWith("sha512-")) {
      problems.push(`${key} has no sha512 integrity`);
    }
    if (typeof meta.resolved !== "string" || !meta.resolved.startsWith("https://")) {
      problems.push(`${key} has no https download address`);
    }
  }
  const keys = Object.keys(packages);
  for (const required of requiredPackages) {
    if (
      !keys.some(
        (key) => key === `node_modules/${required}` || key.endsWith(`/node_modules/${required}`)
      )
    ) {
      problems.push(`required package ${required} is missing from the lockfile`);
    }
  }
  return problems;
}

/** Entries an instance can install: no `os` restriction, or one that includes linux. */
export function installableEntries(lockfile: NpmLockfile): InstallableEntry[] {
  const out: InstallableEntry[] = [];
  for (const [key, meta] of Object.entries(lockfile.packages ?? {})) {
    if (key === "" || meta.link === true) continue;
    if (meta.os && !meta.os.includes("linux")) continue;
    out.push({
      key,
      name: meta.name ?? nameFromKey(key),
      version: meta.version ?? "",
      resolved: meta.resolved ?? "",
      integrity: meta.integrity ?? ""
    });
  }
  return out;
}

// ─── provenance ─────────────────────────────────────────────────────────────

export interface ProvenanceObservation {
  readonly name: string;
  readonly version: string;
  /** Source repository named by the SLSA provenance, or null when the version has none. */
  readonly sourceRepo: string | null;
}

export interface ProvenanceVerdict {
  readonly problems: readonly string[];
  /** Names seen with provenance this run, to merge into the history. */
  readonly carried: readonly string[];
}

function normalizeRepo(repo: string): string {
  return repo
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Spec 4.3: a recorded source repository must match; a package that carried provenance before
 * and now arrives without it blocks; a package that never carried it is allowed.
 */
export function evaluateProvenance(
  observations: readonly ProvenanceObservation[],
  history: ReadonlySet<string>,
  expectedRepos: Readonly<Record<string, string>>
): ProvenanceVerdict {
  const problems: string[] = [];
  const carried: string[] = [];
  for (const { name, version, sourceRepo } of observations) {
    if (sourceRepo === null) {
      if (history.has(name)) {
        problems.push(
          `${name}@${version} has no provenance, but earlier versions did; it may have been published outside the maker's pipeline`
        );
      }
      continue;
    }
    carried.push(name);
    const expected = expectedRepos[name];
    if (expected && normalizeRepo(expected) !== normalizeRepo(sourceRepo)) {
      problems.push(`${name}@${version} was built from ${sourceRepo}, expected ${expected}`);
    }
  }
  return { problems, carried: [...new Set(carried)].sort() };
}

/** The source repository named by one decoded SLSA provenance statement, or null. */
export function provenanceSourceRepo(statement: unknown): string | null {
  if (typeof statement !== "object" || statement === null) return null;
  const predicate = (statement as { predicate?: unknown }).predicate;
  if (typeof predicate !== "object" || predicate === null) return null;
  const workflow = (
    predicate as {
      buildDefinition?: { externalParameters?: { workflow?: { repository?: unknown } } };
    }
  ).buildDefinition?.externalParameters?.workflow;
  return typeof workflow?.repository === "string" ? workflow.repository : null;
}
