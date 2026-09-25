/**
 * #2689: publish the signed CLI tools manifest (spec 2026-09-25 sections 4.1, 4.3, 5.1).
 *
 * For each toolset: pick the newest stable version of every package, and when anything is newer
 * than the published manifest, generate lockfiles and run the release trust checks and the
 * offline contract check. A toolset that passes gets a new manifest entry; one that fails keeps
 * its previous entry and gets a GitHub issue. The workflow uploads whatever lands in --out.
 *
 * Usage:
 *   pnpm tsx scripts/cli-tools/publish-cli-tools-manifest.ts --out <dir> --work <dir>
 *     [--previous <dir>] [--require-signature] [--file-issues]
 *     [--only <toolset>] [--pin <pkg>@<version>] [--break-check-for <toolset>]
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PROVIDER_CATALOG } from "../../packages/cli-runner/src/catalog.js";
import {
  CLI_TOOLS_MANIFEST_FILENAME,
  CLI_TOOLS_MANIFEST_FORMAT_VERSION,
  CLI_TOOLS_MANIFEST_KIND,
  lockfileAssetName,
  parseCliToolsManifest,
  type CliToolsManifest,
  type CliToolsManifestPackage,
  type CliToolsManifestToolset
} from "../../packages/cli-runner/src/cli-tools/manifest.js";
import {
  CLI_TOOLSETS,
  EXPECTED_PROVENANCE_REPOS,
  type CliToolsetDefinition,
  type CliToolsetId
} from "../../packages/cli-runner/src/cli-tools/toolsets.js";
import {
  evaluateProvenance,
  installableEntries,
  isPublishableVersion,
  lockfileProblems,
  pickLatestStable,
  type NpmLockfile
} from "../../packages/cli-runner/src/cli-tools/trust-checks.js";
import {
  MODULE_CATALOG_PUBLIC_KEYS,
  resolveCatalogSigningKey,
  signCatalogBytes,
  verifyCatalogBytes
} from "../../packages/module-registry/src/node.js";
import { runContractCheck } from "./contract-check.js";
import {
  checkRegistrySignatures,
  checkTarballChecksums,
  fetchPackument,
  observeProvenance,
  prepareLockfile,
  runCommand
} from "./release-trust.js";

export const PROVENANCE_HISTORY_FILENAME = "provenance-history.json";

interface Options {
  readonly outDir: string;
  readonly workDir: string;
  readonly previousDir?: string;
  readonly requireSignature: boolean;
  readonly fileIssues: boolean;
  readonly only?: CliToolsetId;
  readonly pin?: { readonly pkg: string; readonly version: string };
  readonly breakCheckFor?: CliToolsetId;
}

interface Blocked {
  readonly pkg: string;
  readonly version: string;
  readonly step: string;
  readonly problems: readonly string[];
}

interface Candidate {
  readonly role: CliToolsManifestPackage["role"];
  readonly pkg: string;
  readonly version: string;
  readonly lockfilePath: string;
  readonly provenance: CliToolsManifestPackage["provenance"];
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const toolset = (raw: string | undefined, flag: string): CliToolsetId | undefined => {
    if (!raw) return undefined;
    if (!CLI_TOOLSETS.some((entry) => entry.id === raw))
      throw new Error(`${flag}: unknown toolset ${raw}`);
    return raw as CliToolsetId;
  };
  const outDir = value("--out");
  const workDir = value("--work");
  if (!outDir || !workDir) throw new Error("--out and --work are required");
  const pinRaw = value("--pin");
  let pin: Options["pin"];
  if (pinRaw) {
    const at = pinRaw.lastIndexOf("@");
    if (at <= 0) throw new Error("--pin must look like <pkg>@<version>");
    pin = { pkg: pinRaw.slice(0, at), version: pinRaw.slice(at + 1) };
    if (!CLI_TOOLSETS.some((entry) => entry.packages.some((p) => p.pkg === pin!.pkg))) {
      throw new Error(`--pin: ${pin.pkg} is not in any toolset`);
    }
  }
  return {
    outDir,
    workDir,
    previousDir: value("--previous"),
    requireSignature: argv.includes("--require-signature"),
    fileIssues: argv.includes("--file-issues"),
    only: toolset(value("--only"), "--only"),
    pin,
    breakCheckFor: toolset(value("--break-check-for"), "--break-check-for")
  };
}

/** The last published manifest, signature-checked. Absent on the first publish. */
async function loadPrevious(dir: string | undefined): Promise<CliToolsManifest | null> {
  if (!dir) return null;
  const manifestPath = path.join(dir, CLI_TOOLS_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  const bytes = await readFile(manifestPath);
  const signature = JSON.parse(await readFile(`${manifestPath}.sig`, "utf8")) as unknown;
  const verdict = verifyCatalogBytes(bytes, signature, MODULE_CATALOG_PUBLIC_KEYS);
  if (!verdict.verified) {
    throw new Error(
      `the published manifest fails its signature check (${verdict.reason}); refusing to build on it`
    );
  }
  const parsed = parseCliToolsManifest(JSON.parse(bytes.toString("utf8")));
  if (!parsed.ok) throw new Error(`the published manifest does not parse: ${parsed.reason}`);
  return parsed.manifest;
}

async function loadHistory(dir: string | undefined): Promise<Set<string>> {
  const file = dir ? path.join(dir, PROVENANCE_HISTORY_FILENAME) : undefined;
  if (!file || !existsSync(file)) return new Set();
  const parsed = JSON.parse(await readFile(file, "utf8")) as { packages?: unknown };
  return new Set(
    Array.isArray(parsed.packages) ? parsed.packages.filter((p) => typeof p === "string") : []
  );
}

/** A previous lockfile to reuse for an unchanged version, after checking it against its hash. */
async function reusableLockfile(
  previousDir: string | undefined,
  entry: CliToolsManifestPackage | undefined,
  version: string
): Promise<string | undefined> {
  if (!previousDir || !entry || entry.version !== version) return undefined;
  const file = path.join(previousDir, entry.lockfile);
  if (!existsSync(file)) return undefined;
  return sha256(await readFile(file)) === entry.lockfileSha256 ? file : undefined;
}

async function checkToolset(
  definition: CliToolsetDefinition,
  versions: ReadonlyMap<string, string>,
  previous: CliToolsManifestToolset | undefined,
  options: Options,
  history: Set<string>
): Promise<{ candidates: Candidate[]; blocked: Blocked[] }> {
  const blocked: Blocked[] = [];
  const candidates: Candidate[] = [];
  const cliRecipe = PROVIDER_CATALOG[definition.id].recipe;
  const archPackages =
    cliRecipe?.kind === "npm" && cliRecipe.archBinaryPackage
      ? Object.values(cliRecipe.archBinaryPackage)
      : [];

  for (const { role, pkg } of definition.packages) {
    const version = versions.get(pkg)!;
    const block = (step: string, problems: readonly string[]): void => {
      blocked.push({ pkg, version, step, problems });
    };
    const dir = path.join(options.workDir, definition.id, role);
    const prevEntry = previous?.packages.find((entry) => entry.pkg === pkg);
    let lockfilePath: string;
    try {
      lockfilePath = await prepareLockfile(
        dir,
        pkg,
        version,
        await reusableLockfile(options.previousDir, prevEntry, version)
      );
    } catch (error) {
      block("lockfile", [(error as Error).message]);
      continue;
    }
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8")) as NpmLockfile;
    const shape = lockfileProblems(lockfile, role === "cli" ? archPackages : []);
    if (shape.length > 0) {
      block("lockfile", shape);
      continue;
    }
    const entries = installableEntries(lockfile);
    const checksums = await checkTarballChecksums(entries);
    if (checksums.length > 0) {
      block("checksums", checksums);
      continue;
    }
    const signatures = await checkRegistrySignatures(dir);
    if (signatures.length > 0) {
      block("registry signatures", signatures);
      continue;
    }
    const observations = await observeProvenance(entries);
    const provenance = evaluateProvenance(observations, history, EXPECTED_PROVENANCE_REPOS);
    for (const name of provenance.carried) history.add(name);
    if (provenance.problems.length > 0) {
      block("provenance", provenance.problems);
      continue;
    }
    const top = observations.find((entry) => entry.name === pkg && entry.version === version);
    candidates.push({
      role,
      pkg,
      version,
      lockfilePath,
      provenance: top?.sourceRepo ? "verified" : "none"
    });
  }
  if (blocked.length > 0) return { candidates, blocked };

  const cli = candidates.find((entry) => entry.role === "cli")!;
  const adapter = candidates.find((entry) => entry.role === "chat-adapter");
  const problems = await runContractCheck({
    toolset: definition.id,
    cli: { pkg: cli.pkg, version: cli.version, lockfilePath: cli.lockfilePath },
    adapter: adapter && {
      pkg: adapter.pkg,
      version: adapter.version,
      lockfilePath: adapter.lockfilePath
    },
    workDir: path.join(options.workDir, definition.id, "contract"),
    breakContract: options.breakCheckFor === definition.id
  });
  if (problems.length > 0) {
    const handshake = problems.filter((problem) => problem.startsWith("chat adapter"));
    const cliProblems = problems.filter((problem) => !problem.startsWith("chat adapter"));
    if (cliProblems.length > 0)
      blocked.push({
        pkg: cli.pkg,
        version: cli.version,
        step: "contract check",
        problems: cliProblems
      });
    if (handshake.length > 0 && adapter) {
      blocked.push({
        pkg: adapter.pkg,
        version: adapter.version,
        step: "contract check",
        problems: handshake
      });
    }
  }
  return { candidates, blocked };
}

/** True when the issue's latest post already lists the same problems, so a scheduled rerun stays quiet. */
async function issueAlreadySays(issueNumber: number, entry: Blocked): Promise<boolean> {
  const view = await runCommand(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "body,comments"],
    process.cwd()
  );
  if (view.code !== 0) return false;
  const issue = JSON.parse(view.output) as { body: string; comments: { body: string }[] };
  const latest = issue.comments.at(-1)?.body ?? issue.body;
  return (
    latest.includes(`Failing step: ${entry.step}`) &&
    entry.problems.every((problem) => latest.includes(`- ${problem}`))
  );
}

async function fileIssue(toolset: CliToolsetId, entry: Blocked): Promise<void> {
  const title = `CLI tool update blocked: ${entry.pkg} ${entry.version}`;
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "local run";
  const body = [
    `The CLI tools manifest publisher held back the **${toolset}** toolset. Instances keep the tools they have until this passes.`,
    "",
    `Failing step: ${entry.step}`,
    "",
    ...entry.problems.map((problem) => `- ${problem}`),
    "",
    `Run: ${runUrl}`
  ].join("\n");
  const list = await runCommand(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number,title"
    ],
    process.cwd()
  );
  if (list.code !== 0) throw new Error(`gh issue list failed: ${list.output}`);
  const existing = (JSON.parse(list.output) as { number: number; title: string }[]).find(
    (issue) => issue.title === title
  );
  if (existing && (await issueAlreadySays(existing.number, entry))) {
    console.log(`[cli-tools] issue #${existing.number} already reports these problems: ${title}`);
    return;
  }
  const result = existing
    ? await runCommand(
        "gh",
        ["issue", "comment", String(existing.number), "--body", body],
        process.cwd()
      )
    : await runCommand(
        "gh",
        ["issue", "create", "--title", title, "--label", "bug", "--body", body],
        process.cwd()
      );
  if (result.code !== 0)
    throw new Error(`could not file the blocked-update issue: ${result.output}`);
  console.log(
    `[cli-tools] ${existing ? `updated issue #${existing.number}` : "opened issue"}: ${title}`
  );
}

export async function publish(options: Options): Promise<void> {
  await mkdir(options.outDir, { recursive: true });
  const previous = await loadPrevious(options.previousDir);
  const history = await loadHistory(options.previousDir);
  const historyBefore = history.size;
  const signingKey = resolveCatalogSigningKey(process.env);
  if (options.requireSignature && !signingKey) {
    throw new Error("--require-signature was set but no signing key is configured");
  }

  const toolsets: Partial<Record<CliToolsetId, CliToolsManifestToolset>> = {
    ...(previous?.toolsets ?? {})
  };
  let changed = false;
  const allBlocked: { toolset: CliToolsetId; entry: Blocked }[] = [];

  for (const definition of CLI_TOOLSETS) {
    if (options.only && options.only !== definition.id) continue;
    const prior = previous?.toolsets[definition.id];
    const versions = new Map<string, string>();
    const pinProblems: Blocked[] = [];
    for (const { pkg } of definition.packages) {
      const packument = await fetchPackument(pkg);
      if (options.pin?.pkg === pkg) {
        if (!isPublishableVersion(packument, options.pin.version)) {
          pinProblems.push({
            pkg,
            version: options.pin.version,
            step: "version",
            problems: ["not a published, stable, non-deprecated version"]
          });
        }
        versions.set(pkg, options.pin.version);
        continue;
      }
      const latest = pickLatestStable(packument);
      if (!latest) throw new Error(`${pkg} has no stable version on the registry`);
      versions.set(pkg, latest);
    }
    const unchanged =
      prior !== undefined &&
      definition.packages.every(
        ({ pkg }) =>
          prior.packages.find((entry) => entry.pkg === pkg)?.version === versions.get(pkg)
      );
    const summary = [...versions].map(([pkg, version]) => `${pkg}@${version}`).join(", ");
    if (unchanged && options.breakCheckFor !== definition.id) {
      console.log(`[cli-tools] ${definition.id}: unchanged (${summary})`);
      continue;
    }
    console.log(`[cli-tools] ${definition.id}: checking ${summary}`);
    const { candidates, blocked } =
      pinProblems.length > 0
        ? { candidates: [], blocked: pinProblems }
        : await checkToolset(definition, versions, prior, options, history);
    if (blocked.length > 0) {
      for (const entry of blocked) {
        console.log(
          `[cli-tools] ${definition.id}: BLOCKED at ${entry.step} for ${entry.pkg}@${entry.version}`
        );
        for (const problem of entry.problems) console.log(`[cli-tools]   - ${problem}`);
        allBlocked.push({ toolset: definition.id, entry });
      }
      continue;
    }

    const packages: CliToolsManifestPackage[] = [];
    for (const candidate of candidates) {
      const lockfile = lockfileAssetName(definition.id, candidate.role, candidate.version);
      await copyFile(candidate.lockfilePath, path.join(options.outDir, lockfile));
      packages.push({
        role: candidate.role,
        pkg: candidate.pkg,
        version: candidate.version,
        lockfile,
        lockfileSha256: sha256(await readFile(candidate.lockfilePath)),
        provenance: candidate.provenance
      });
    }
    toolsets[definition.id] = definition.minMossVersion
      ? { packages, minMossVersion: definition.minMossVersion }
      : { packages };
    changed = true;
    console.log(`[cli-tools] ${definition.id}: passed`);
  }

  if (history.size !== historyBefore) {
    await writeFile(
      path.join(options.outDir, PROVENANCE_HISTORY_FILENAME),
      JSON.stringify({ packages: [...history].sort() }, null, 2) + "\n"
    );
  }

  if (changed) {
    // Carry forward the lockfiles of untouched toolsets so the release keeps every referenced asset.
    for (const toolset of Object.values(toolsets)) {
      for (const entry of toolset?.packages ?? []) {
        const target = path.join(options.outDir, entry.lockfile);
        if (existsSync(target)) continue;
        const source = options.previousDir ? path.join(options.previousDir, entry.lockfile) : "";
        if (!source || !existsSync(source))
          throw new Error(`previous lockfile ${entry.lockfile} is missing`);
        await copyFile(source, target);
      }
    }
    const manifest: CliToolsManifest = {
      kind: CLI_TOOLS_MANIFEST_KIND,
      formatVersion: CLI_TOOLS_MANIFEST_FORMAT_VERSION,
      issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      sequence: (previous?.sequence ?? 0) + 1,
      toolsets
    };
    const json = JSON.stringify(manifest, null, 2) + "\n";
    const bytes = Buffer.from(json, "utf8");
    await writeFile(path.join(options.outDir, CLI_TOOLS_MANIFEST_FILENAME), json);
    if (signingKey) {
      const signature = signCatalogBytes(bytes, signingKey.privateKeyPem, signingKey.keyId);
      const selfCheck = verifyCatalogBytes(bytes, signature, MODULE_CATALOG_PUBLIC_KEYS);
      if (!selfCheck.verified) {
        throw new Error(`the freshly signed manifest fails verification (${selfCheck.reason})`);
      }
      await writeFile(
        path.join(options.outDir, `${CLI_TOOLS_MANIFEST_FILENAME}.sig`),
        JSON.stringify(signature, null, 2) + "\n"
      );
    }
    console.log(`[cli-tools] wrote manifest sequence ${manifest.sequence}`);
  } else {
    console.log("[cli-tools] nothing new passed; no manifest written");
  }

  if (options.fileIssues) {
    for (const { toolset, entry } of allBlocked) await fileIssue(toolset, entry);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  publish(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`[cli-tools] failed: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
