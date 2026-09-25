/**
 * #2689: the network half of the publisher's release trust checks (spec 2026-09-25 section 4.3).
 * Pure rules live in packages/cli-runner/src/cli-tools/trust-checks.ts.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  provenanceSourceRepo,
  type InstallableEntry,
  type NpmPackument,
  type ProvenanceObservation
} from "../../packages/cli-runner/src/cli-tools/trust-checks.js";

const REGISTRY = "https://registry.npmjs.org";
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const PARALLEL_DOWNLOADS = 6;

function registryPath(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = response.status === 404 ? null : await response.json();
  if (!response.ok && response.status !== 404) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  return { status: response.status, body };
}

export async function fetchPackument(name: string): Promise<NpmPackument> {
  const { status, body } = await fetchJson(`${REGISTRY}/${registryPath(name)}`);
  if (status === 404) throw new Error(`${name} is not on the npm registry`);
  return body as NpmPackument;
}

export interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < 200_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ code: null, output: String(error) }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/**
 * Generate a lockfile for one exact package version in `dir`. With `reuse`, copy that lockfile
 * instead, so an unchanged version keeps the exact bytes its manifest entry already hashes.
 */
export async function prepareLockfile(
  dir: string,
  pkg: string,
  version: string,
  reuse?: string
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const lockfile = path.join(dir, "package-lock.json");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "moss-cli-tools-lock",
      version: "0.0.0",
      dependencies: { [pkg]: version }
    })
  );
  if (reuse) {
    await copyFile(reuse, lockfile);
    return lockfile;
  }
  const result = await runCommand(
    "npm",
    [
      "install",
      `${pkg}@${version}`,
      "--save-exact",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ],
    dir
  );
  if (result.code !== 0)
    throw new Error(`npm could not resolve ${pkg}@${version}: ${result.output.slice(-400)}`);
  return lockfile;
}

async function sha512Of(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`download of ${url} answered ${response.status}`);
  const hash = createHash("sha512");
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
    hash.update(chunk);
  return `sha512-${hash.digest("base64")}`;
}

async function inBatches<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(PARALLEL_DOWNLOADS, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Download every tarball an instance can install and check it against both the lockfile's sha512
 * and the registry's own `dist.integrity`. Returns one problem per mismatch.
 */
export async function checkTarballChecksums(
  entries: readonly InstallableEntry[]
): Promise<string[]> {
  const found = await inBatches(entries, async (entry) => {
    const problems: string[] = [];
    const doc = await fetchJson(
      `${REGISTRY}/${registryPath(entry.name)}/${encodeURIComponent(entry.version)}`
    );
    const registryIntegrity = (doc.body as { dist?: { integrity?: string } } | null)?.dist
      ?.integrity;
    if (doc.status === 404 || !registryIntegrity) {
      problems.push(`${entry.name}@${entry.version} is no longer on the registry`);
      return problems;
    }
    if (registryIntegrity !== entry.integrity) {
      problems.push(`${entry.name}@${entry.version} lockfile checksum differs from the registry's`);
    }
    const actual = await sha512Of(entry.resolved);
    if (actual !== entry.integrity) {
      problems.push(`${entry.name}@${entry.version} download does not match its sha512`);
    }
    return problems;
  });
  return found.flat();
}

/** Registry signature and attestation check over an installed copy of the lockfile. */
export async function checkRegistrySignatures(lockDir: string): Promise<string[]> {
  const install = await runCommand(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    lockDir
  );
  if (install.code !== 0) return [`npm ci failed: ${install.output.slice(-400)}`];
  const audit = await runCommand("npm", ["audit", "signatures"], lockDir);
  if (audit.code !== 0) return [`npm audit signatures failed: ${audit.output.slice(-600)}`];
  return [];
}

/** The SLSA source repository of each entry, or null when it carries no provenance. */
export async function observeProvenance(
  entries: readonly InstallableEntry[]
): Promise<ProvenanceObservation[]> {
  return inBatches(entries, async (entry) => {
    const { status, body } = await fetchJson(
      `${REGISTRY}/-/npm/v1/attestations/${registryPath(entry.name)}@${encodeURIComponent(entry.version)}`
    );
    const attestations = (body as { attestations?: unknown[] } | null)?.attestations;
    if (status === 404 || !Array.isArray(attestations)) {
      return { name: entry.name, version: entry.version, sourceRepo: null };
    }
    const slsa = attestations.find(
      (item) => (item as { predicateType?: unknown }).predicateType === SLSA_PROVENANCE
    ) as { bundle?: { dsseEnvelope?: { payload?: string } } } | undefined;
    if (!slsa) return { name: entry.name, version: entry.version, sourceRepo: null };
    let repo = "";
    try {
      const payload = slsa.bundle?.dsseEnvelope?.payload ?? "";
      repo =
        provenanceSourceRepo(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))) ?? "";
    } catch {
      // An attestation whose repository cannot be read counts as carried with an unknown source,
      // which fails the expected-repository check.
    }
    return { name: entry.name, version: entry.version, sourceRepo: repo };
  });
}
