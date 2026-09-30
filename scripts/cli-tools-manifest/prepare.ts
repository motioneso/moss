// The code-free half of a publisher run (spec 4.1, 4.3): picks versions, generates lockfiles and
// checks them. Nothing here runs package code. `npm ci --ignore-scripts` only unpacks files.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertArchPackages,
  assertLockfileIntegrity,
  assertPinnedVersion,
  generateLockfile,
  listLockEntries,
  type RunNpm
} from "./lockfile.js";
import {
  compareVersions,
  type CliToolsManifest,
  type ManifestPackage,
  type ManifestToolset
} from "./manifest.js";
import type { PublisherPackage } from "./packages.js";
import { assertNotRollback, publishedVersion } from "./sign-assemble.js";
import { checkProvenance, checkTarball, type Attestations } from "./trust.js";
import { pickVersion } from "./versions.js";

const REGISTRY_PREFIX = "https://registry.npmjs.org/";

export interface VersionMeta {
  readonly deprecated?: string;
  readonly dist?: { readonly integrity?: string };
}

/** The registry, injected so tests need no network. */
export interface Registry {
  packument(pkg: string): Promise<{ readonly versions: Readonly<Record<string, VersionMeta>> }>;
  /** Null when the registry has no attestation for this version. */
  attestations(pkg: string, version: string): Promise<Attestations | null>;
  tarball(url: string): Promise<Uint8Array>;
}

export interface PrepareInput {
  readonly packages: readonly PublisherPackage[];
  readonly previous: CliToolsManifest | null;
  readonly registry: Registry;
  readonly runNpm: RunNpm;
  readonly outDir: string;
  readonly minMossVersion: string;
  /** Set by a manual run. Forces that package to the named version. */
  readonly requested?: { readonly pkg: string; readonly version: string };
}

export interface ToolsetOutcome {
  readonly toolset: string;
  readonly status: "updated" | "unchanged" | "blocked";
  readonly failures: readonly string[];
  /** The package and version the failure is about, for the issue title. */
  readonly subject?: { readonly pkg: string; readonly version: string };
  /** For "updated": the full package list, carried entries included. */
  readonly manifestToolset?: ManifestToolset;
  /** For "updated": packages whose provenance passed, for the signed history. */
  readonly attested?: readonly { readonly pkg: string; readonly version: string }[];
  /** For "updated": the packages the contract check must run against. */
  readonly candidates?: readonly {
    readonly role: ManifestPackage["role"];
    readonly pkg: string;
    readonly version: string;
    readonly lockfile: string;
  }[];
}

export interface PrepareResult {
  readonly outcomes: readonly ToolsetOutcome[];
  readonly attested: readonly { readonly pkg: string; readonly version: string }[];
}

function lockfileName(toolset: string, role: ManifestPackage["role"], version: string): string {
  return `${toolset}-${role === "cli" ? "cli" : "adapter"}-${version}.json`;
}

interface Checked {
  readonly manifestPackage: ManifestPackage;
  readonly attested: readonly { pkg: string; version: string }[];
}

class Blocked extends Error {
  constructor(
    readonly failures: string[],
    readonly subject: { pkg: string; version: string }
  ) {
    super(failures.join("; "));
  }
}

async function prepareOne(
  input: PrepareInput,
  spec: PublisherPackage,
  version: string,
  toolset: string
): Promise<Checked> {
  const subject = { pkg: spec.pkg, version };
  const history = input.previous?.provenanceHistory ?? {};
  const { dir, lockfile } = await generateLockfile(input.runNpm, spec.pkg, version);
  const problems = [
    ...assertLockfileIntegrity(lockfile),
    ...assertPinnedVersion(lockfile, spec.pkg, version),
    ...assertArchPackages(lockfile, spec.archPackages)
  ];
  if (problems.length > 0) throw new Blocked(problems, subject);

  const attested: { pkg: string; version: string }[] = [];
  let topLevel: "attested" | "none" = "none";
  const watched = new Set([spec.pkg, ...spec.archPackages]);

  for (const entry of listLockEntries(lockfile)) {
    const at = `${entry.installedAs}@${entry.version}`;
    // An alias (codex ships its platform binaries as versions of itself) may only point at
    // a package this toolset already names.
    if (entry.aliased && entry.name !== spec.pkg && !watched.has(entry.name)) {
      throw new Blocked([`${at} is an alias for unrelated package ${entry.name}`], subject);
    }
    if (!entry.resolved.startsWith(REGISTRY_PREFIX)) {
      throw new Blocked([`${at} is not fetched from the npm registry`], subject);
    }
    const meta = (await input.registry.packument(entry.name)).versions[entry.version];
    const distIntegrity = meta?.dist?.integrity;
    if (distIntegrity === undefined) {
      throw new Blocked([`${at} has no registry integrity to compare`], subject);
    }
    const bytes = await input.registry.tarball(entry.resolved);
    const tarballProblems = checkTarball(bytes, entry.integrity, distIntegrity);
    if (tarballProblems.length > 0) {
      throw new Blocked(
        tarballProblems.map((m) => `${at}: ${m}`),
        subject
      );
    }
    if (!watched.has(entry.installedAs) || entry.key !== `node_modules/${entry.installedAs}`) {
      continue;
    }
    const verdict = checkProvenance({
      pkg: entry.installedAs,
      expectedRepo: spec.expectedRepo,
      attestations: await input.registry.attestations(entry.name, entry.version),
      tarballIntegrity: entry.integrity,
      history
    });
    if (!verdict.ok) throw new Blocked([...verdict.errors], subject);
    if (verdict.provenance === "attested")
      attested.push({ pkg: entry.installedAs, version: entry.version });
    if (entry.installedAs === spec.pkg) topLevel = verdict.provenance;
  }

  // Unpacks without running any package script, then checks the registry's own signatures.
  await input.runNpm(["ci", "--ignore-scripts"], dir);
  await input.runNpm(["audit", "signatures"], dir);

  const name = lockfileName(toolset, spec.role, version);
  await writeFile(path.join(input.outDir, name), lockfile);
  return {
    attested,
    manifestPackage: {
      role: spec.role,
      pkg: spec.pkg,
      version,
      lockfile: name,
      lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
      provenance: topLevel
    }
  };
}

export async function prepare(input: PrepareInput): Promise<PrepareResult> {
  await mkdir(input.outDir, { recursive: true });
  const toolsets = [...new Set(input.packages.map((p) => p.toolset))];
  const outcomes: ToolsetOutcome[] = [];
  const attested: { pkg: string; version: string }[] = [];

  for (const toolset of toolsets) {
    const specs = input.packages.filter((p) => p.toolset === toolset);
    const work: { spec: PublisherPackage; version: string }[] = [];
    let subject: { pkg: string; version: string } | undefined;
    try {
      for (const spec of specs) {
        subject = { pkg: spec.pkg, version: "" };
        const asked = input.requested?.pkg === spec.pkg ? input.requested.version : undefined;
        const version = asked ?? pickVersion(await input.registry.packument(spec.pkg));
        if (version === null) throw new Blocked([`${spec.pkg} has no eligible version`], subject);
        subject = { pkg: spec.pkg, version };
        if (asked !== undefined) assertNotRollback(input.previous, toolset, spec.pkg, asked);
        const published = publishedVersion(input.previous, toolset, spec.pkg);
        // A scheduled run never moves a package backwards, for example after an unpublish.
        if (published !== null && compareVersions(version, published) <= 0) continue;
        work.push({ spec, version });
      }
      if (work.length === 0) {
        outcomes.push({ toolset, status: "unchanged", failures: [] });
        continue;
      }
      const fresh = new Map<string, ManifestPackage>();
      const toolsetAttested: { pkg: string; version: string }[] = [];
      for (const { spec, version } of work) {
        subject = { pkg: spec.pkg, version };
        const checked = await prepareOne(input, spec, version, toolset);
        fresh.set(spec.pkg, checked.manifestPackage);
        toolsetAttested.push(...checked.attested);
      }
      const packages = specs.map((spec) => {
        const next = fresh.get(spec.pkg);
        if (next !== undefined) return next;
        const kept = input.previous?.toolsets[toolset]?.packages.find((p) => p.pkg === spec.pkg);
        if (kept === undefined) throw new Error(`no version chosen for ${spec.pkg}`);
        return kept;
      });
      attested.push(...toolsetAttested);
      outcomes.push({
        toolset,
        status: "updated",
        failures: [],
        attested: toolsetAttested,
        manifestToolset: { packages, minMossVersion: input.minMossVersion },
        candidates: packages.map((p) => ({
          role: p.role,
          pkg: p.pkg,
          version: p.version,
          lockfile: p.lockfile
        }))
      });
    } catch (err) {
      const failures = err instanceof Blocked ? err.failures : [errorMessage(err)];
      outcomes.push({
        toolset,
        status: "blocked",
        failures,
        subject: err instanceof Blocked ? err.subject : subject
      });
    }
  }
  return { outcomes, attested };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
