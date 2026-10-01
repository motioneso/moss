// Entry points for the three workflow jobs. See .github/workflows/cli-tools-manifest.yml.
//   prepare  code-free: choose versions, build and check lockfiles
//   check    no secrets: run the candidate tools through the offline contract check
//   digest   fingerprint the prepared bundle so the sign job can detect tampering
//   sign     no package code: verify, assemble and sign the manifest
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveCatalogSigningKey } from "../../packages/module-registry/src/node.js";
import { assertBundleDigest, bundleDigest } from "./bundle-digest.js";
import { runContractCheck, type ToolsetCandidate } from "./contract-check.js";
import { captureLaunchCommands } from "./launch-commands.js";
import { isStableVersion, type CliToolsManifest } from "./manifest.js";
import { loadPublisherPackages } from "./packages.js";
import { prepare, type PrepareResult, type Registry } from "./prepare.js";
import { planPublish, readCheckPasses } from "./publish.js";
import { loadPreviousManifest, signManifest } from "./sign-assemble.js";

const execFileAsync = promisify(execFile);

export const MANIFEST_FILE = "cli-tools-manifest.json";
export const SIGNATURE_FILE = "cli-tools-manifest.json.sig";
const PREPARE_RESULT = "prepare-result.json";
const CHECK_RESULT = "check-result.json";
const BLOCKED_FILE = "blocked.json";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function required(name: string): string {
  const v = flag(name);
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

function setOutput(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function readOptional(file: string): Promise<Buffer | null> {
  return existsSync(file) ? readFile(file) : null;
}

/** Reads and verifies the previous release's manifest. No files means the first publish. */
async function loadPrevious(dir: string): Promise<CliToolsManifest | null> {
  const bytes = await readOptional(path.join(dir, MANIFEST_FILE));
  const sig = await readOptional(path.join(dir, SIGNATURE_FILE));
  let signature: unknown = null;
  if (sig !== null) {
    try {
      signature = JSON.parse(sig.toString("utf8"));
    } catch {
      throw new Error("published signature file is not valid JSON");
    }
  }
  return loadPreviousManifest(bytes, signature);
}

function npmPath(name: string): string {
  return name.replace("/", "%2F");
}

function httpRegistry(): Registry {
  const cache = new Map<string, Promise<unknown>>();
  const getJson = async (url: string, headers: Record<string, string> = {}): Promise<unknown> => {
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  };
  return {
    async packument(pkg) {
      let hit = cache.get(pkg);
      if (hit === undefined) {
        hit = getJson(`https://registry.npmjs.org/${npmPath(pkg)}`, {
          accept: "application/vnd.npm.install-v1+json"
        });
        cache.set(pkg, hit);
      }
      const doc = (await hit) as { versions?: Record<string, never> } | null;
      if (doc === null || doc.versions === undefined) throw new Error(`${pkg} is not on npm`);
      return { versions: doc.versions };
    },
    async attestations(pkg, version) {
      return (await getJson(
        `https://registry.npmjs.org/-/npm/v1/attestations/${npmPath(pkg)}@${version}`
      )) as never;
    },
    async tarball(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
  };
}

async function runPrepare(): Promise<void> {
  const out = required("out");
  const previous = await loadPrevious(required("previous-dir"));
  const packages = loadPublisherPackages();

  const askedPkg = process.env.INPUT_PACKAGE ?? "";
  const askedVersion = process.env.INPUT_VERSION ?? "";
  let requested: { pkg: string; version: string } | undefined;
  if (askedPkg !== "" || askedVersion !== "") {
    if (!packages.some((p) => p.pkg === askedPkg)) throw new Error(`unknown package "${askedPkg}"`);
    if (!isStableVersion(askedVersion)) throw new Error("version must be an exact stable x.y.z");
    requested = { pkg: askedPkg, version: askedVersion };
  }

  const rootPkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const result = await prepare({
    packages,
    previous,
    registry: httpRegistry(),
    outDir: out,
    minMossVersion: rootPkg.version,
    requested,
    runNpm: async (args, cwd) => {
      await execFileAsync("npm", [...args], { cwd, timeout: 600_000, maxBuffer: 50_000_000 });
    }
  });

  // Packages carried over from the previous manifest keep their published lockfile, checked
  // against the hash the signed manifest pins.
  for (const outcome of result.outcomes) {
    for (const p of outcome.manifestToolset?.packages ?? []) {
      const target = path.join(out, p.lockfile);
      if (!existsSync(target)) {
        await copyFile(path.join(required("previous-dir"), p.lockfile), target);
      }
      const sha = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      if (sha !== p.lockfileSha256) throw new Error(`${p.lockfile} does not match its pinned hash`);
    }
  }

  await writeFile(path.join(out, PREPARE_RESULT), JSON.stringify(result, null, 2));
  for (const o of result.outcomes)
    console.log(`${o.toolset}: ${o.status} ${o.failures.join("; ")}`);
  // A manual run that names a version is expected to publish it, so a block is a failed run.
  if (requested !== undefined && result.outcomes.some((o) => o.status === "blocked")) {
    process.exitCode = 1;
  }
}

async function runCheck(): Promise<void> {
  const dir = required("in");
  const prepared = JSON.parse(
    await readFile(path.join(dir, PREPARE_RESULT), "utf8")
  ) as PrepareResult;
  const commands = await captureLaunchCommands();
  const results: { toolset: string; pass: boolean }[] = [];
  for (const outcome of prepared.outcomes) {
    if (outcome.status !== "updated" || outcome.candidates === undefined) continue;
    const candidate: ToolsetCandidate = {
      toolset: outcome.toolset,
      packages: outcome.candidates.map((c) => ({
        role: c.role,
        pkg: c.pkg,
        version: c.version,
        lockfilePath: path.resolve(dir, c.lockfile)
      }))
    };
    const r = await runContractCheck(candidate, commands);
    console.log(`${r.toolset}: ${r.pass ? "pass" : "FAIL"}`);
    for (const f of r.failures) console.log(`  ${f}`);
    results.push({ toolset: r.toolset, pass: r.pass });
  }
  await writeFile(path.join(dir, CHECK_RESULT), JSON.stringify(results, null, 2));
}

async function runDigest(): Promise<void> {
  setOutput("digest", await bundleDigest(required("in")));
}

async function runSign(): Promise<void> {
  const dir = required("in");
  await assertBundleDigest(dir, process.env.EXPECTED_BUNDLE_DIGEST);
  const previous = await loadPrevious(required("previous-dir"));
  const prepared = JSON.parse(
    await readFile(path.join(dir, PREPARE_RESULT), "utf8")
  ) as PrepareResult;
  const checkRaw = await readOptional(path.join(flag("check-dir") ?? dir, CHECK_RESULT));
  let checkPasses = new Map<string, boolean>();
  if (checkRaw !== null) {
    try {
      checkPasses = readCheckPasses(JSON.parse(checkRaw.toString("utf8")));
    } catch {
      checkPasses = new Map();
    }
  }

  const plan = planPublish({ previous, prepared, checkPasses, issuedAt: new Date().toISOString() });
  await writeFile(path.join(dir, BLOCKED_FILE), JSON.stringify(plan.blocked, null, 2));
  setOutput("blocked", String(plan.blocked.length));
  if (plan.manifest === null) {
    console.log("nothing to publish");
    setOutput("publish", "false");
    return;
  }

  const key = resolveCatalogSigningKey(process.env);
  if (key === null) throw new Error("no signing key is configured");
  const signed = signManifest(plan.manifest, key, {
    allowUnpinnedKey: process.argv.includes("--allow-unpinned-key")
  });
  await writeFile(path.join(dir, MANIFEST_FILE), signed.bytes);
  await writeFile(path.join(dir, SIGNATURE_FILE), `${JSON.stringify(signed.signature, null, 2)}\n`);
  console.log(`signed sequence ${plan.manifest.sequence}`);
  setOutput("publish", "true");
}

const commands: Record<string, () => Promise<void>> = {
  prepare: runPrepare,
  check: runCheck,
  digest: runDigest,
  sign: runSign
};

const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error("usage: cli.ts <prepare|check|digest|sign> [options]");
  process.exit(2);
}
command().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
