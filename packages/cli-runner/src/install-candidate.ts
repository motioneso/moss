import { readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TmuxIo } from "@moss/ai";
import type {
  InstallRecipe,
  NpmInstallRecipe,
  ProviderCatalog,
  RpcCliLastCheck,
  RpcGetCliToolsStateResult,
  RpcInstallProviderResult,
  RpcProviderKind
} from "@moss/chat/live";

import type { AdapterRecipe } from "./catalog.js";
import {
  hashEq,
  isPublishedNpmRelease,
  pathExists,
  randToken,
  redactInstallMessage,
  redactNpm,
  sha512OfResolved,
  splitLines
} from "./install-helpers.js";
import type {
  CandidateInstall,
  CandidatePackage,
  PromoteCandidateResult,
  StageCandidateResult
} from "./install-service.js";
import { hasLiveLease } from "./tools-leases.js";
import { readToolsState, writeToolsState, type StagedPackage } from "./tools-state.js";

/**
 * Staging, promoting and cleaning up toolsets (#2689). The install service passes in the few
 * private pieces these steps need.
 */
export interface CandidateOps {
  readonly toolsPrefix: string;
  readonly catalog: ProviderCatalog;
  readonly io: TmuxIo;
  readonly installerEnv: NodeJS.ProcessEnv;
  adapterFor(provider: RpcProviderKind): AdapterRecipe | undefined;
  resolveRecipe(provider: RpcProviderKind): InstallRecipe;
  installNpm(
    provider: RpcProviderKind,
    recipe: NpmInstallRecipe,
    candidate?: CandidateInstall
  ): Promise<RpcInstallProviderResult>;
  mkStaging(slot: string): Promise<string>;
  stageNpmRelease(slot: string, staging: string): Promise<string>;
  promoteNpm(
    slot: string,
    staging: string,
    binary: string | null
  ): Promise<{ dir: string; prior: string | undefined }>;
  readInstalledVersion(dir: string, pkg: string): Promise<string | undefined>;
  resolveCurrent(slot: string): Promise<string | undefined>;
  resolveRepoPath(repoRel: string): string;
  ensureBinSymlink(provider: string, binary: string): Promise<void>;
  binPath(binary: string): string;
  pinHash(provider: RpcProviderKind, hash: string): void;
}

/** Install or confirm the provider's chat adapter. Returns an error message, or null. */
export async function ensureAdapter(
  ops: CandidateOps,
  provider: RpcProviderKind
): Promise<string | null> {
  const adapter = ops.adapterFor(provider);
  if (!adapter) return null;
  const fail = (why: string): string => `chat adapter ${adapter.pkg}: ${why}`;
  const live = await ops.resolveCurrent(adapter.slot);
  if (
    live &&
    (await isPublishedNpmRelease(live)) &&
    (await ops.readInstalledVersion(live, adapter.pkg)) === adapter.version &&
    (await pathExists(path.join(live, adapter.entry)))
  ) {
    return null;
  }
  const staging = await ops.mkStaging(adapter.slot);
  try {
    await writeFile(
      path.join(staging, "npm-shrinkwrap.json"),
      await readFile(ops.resolveRepoPath(adapter.lockfile), "utf8"),
      "utf8"
    );
    await writeFile(
      path.join(staging, "package.json"),
      JSON.stringify({
        name: "jarv1s-cli-install",
        version: "0.0.0",
        dependencies: { [adapter.pkg]: adapter.version }
      }),
      "utf8"
    );
    const ci = await ops.io.run(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging],
      { cwd: staging, env: ops.installerEnv }
    );
    if (ci.code !== 0) return fail(redactNpm(`npm ci failed: ${ci.stderr ?? ""}`));
    if ((await ops.readInstalledVersion(staging, adapter.pkg)) !== adapter.version) {
      return fail("installed version is not the pinned version");
    }
    if (!(await pathExists(path.join(staging, adapter.entry)))) return fail("entry file missing");
    const release = await ops.promoteNpm(adapter.slot, staging, null);
    await gcOldReleases(ops, adapter.slot, release.dir);
    return null;
  } catch (err) {
    return fail(redactInstallMessage(err));
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stageCandidateLocked(
  ops: CandidateOps,
  provider: RpcProviderKind,
  packages: readonly CandidatePackage[],
  manifestSequence: number
): Promise<StageCandidateResult> {
  if (packages.length === 0) {
    // Nothing newer than live: only record that this manifest was seen. A staged candidate stays.
    const prior = await readToolsState(ops.toolsPrefix, provider);
    await writeToolsState(ops.toolsPrefix, provider, {
      ...prior,
      manifestSequence: Math.max(prior.manifestSequence, manifestSequence)
    });
    return { state: "staged", staged: prior.candidate };
  }
  const staged: StagedPackage[] = [];
  const cleanup = async (): Promise<void> => {
    for (const s of staged) {
      await rm(path.join(ops.toolsPrefix, "providers", s.slot, "releases", s.release), {
        recursive: true,
        force: true
      }).catch(() => undefined);
    }
  };
  try {
    const adapter = ops.adapterFor(provider);
    for (const p of packages) {
      let slot: string;
      let error: string | null;
      let release: string | undefined;
      const onStaged = (dir: string): void => {
        release = path.basename(dir);
      };
      if (p.role === "cli") {
        const recipe = ops.resolveRecipe(provider);
        if (recipe.kind !== "npm" || recipe.pkg !== p.pkg) {
          await cleanup();
          return { state: "error", message: `package ${p.pkg} is not installable here` };
        }
        slot = provider;
        const r = await ops.installNpm(
          provider,
          { ...recipe, version: p.version },
          { lockfileText: p.lockfileText, onStaged }
        );
        error = r.state === "installed" ? null : (r.message ?? "install failed");
      } else {
        if (!adapter || adapter.pkg !== p.pkg) {
          await cleanup();
          return { state: "error", message: `package ${p.pkg} is not installable here` };
        }
        slot = adapter.slot;
        error = await stageAdapter(ops, adapter, p, onStaged);
      }
      if (error !== null || release === undefined) {
        await cleanup();
        return { state: "error", message: error ?? "nothing was staged" };
      }
      staged.push({ role: p.role, slot, pkg: p.pkg, version: p.version, release });
    }
    const prior = await readToolsState(ops.toolsPrefix, provider);
    // Replacing an older candidate frees its releases for the next sweep.
    // A new candidate has not been checked yet, so the last check is dropped.
    const { lastCheck: _dropped, ...kept } = prior;
    await writeToolsState(ops.toolsPrefix, provider, {
      ...kept,
      manifestSequence: Math.max(prior.manifestSequence, manifestSequence),
      candidate: staged
    });
    for (const old of prior.candidate) {
      if (!staged.some((s) => s.slot === old.slot && s.release === old.release)) {
        await removeReleaseIfFree(ops, old.slot, old.release);
      }
    }
    return { state: "staged", staged };
  } catch (err) {
    await cleanup();
    return { state: "error", message: redactInstallMessage(err) };
  }
}

export async function promoteCandidateLocked(
  ops: CandidateOps,
  provider: RpcProviderKind
): Promise<PromoteCandidateResult> {
  const state = await readToolsState(ops.toolsPrefix, provider);
  if (state.candidate.length === 0) return { state: "error", message: "no staged candidate" };
  const flipped: { slot: string; prior: string | undefined }[] = [];
  const newPrior: StagedPackage[] = [];
  const undo = async (): Promise<void> => {
    for (const f of flipped.reverse()) {
      if (!f.prior) continue;
      const dir = path.join(ops.toolsPrefix, "providers", f.slot);
      const tmp = path.join(dir, `.current-${randToken()}`);
      await symlink(f.prior, tmp).catch(() => undefined);
      await rename(tmp, path.join(dir, "current")).catch(() => undefined);
    }
  };
  try {
    let expected: string | undefined;
    let binary: string | undefined;
    for (const c of state.candidate) {
      const dir = path.join(ops.toolsPrefix, "providers", c.slot);
      const releaseDir = path.join(dir, "releases", c.release);
      if (c.role === "cli") {
        const recipe = ops.resolveRecipe(provider);
        if (recipe.kind !== "npm") return { state: "error", message: "not an npm toolset" };
        binary = recipe.binary;
        expected = await sha512OfResolved(
          path.join(releaseDir, "node_modules", ".bin", recipe.binary)
        );
      }
      const link = path.join(dir, "current");
      const priorTarget = await readlink(link).catch(() => undefined);
      const tmp = path.join(dir, `.current-${randToken()}`);
      await symlink(path.join("releases", c.release), tmp);
      await rename(tmp, link);
      flipped.push({ slot: c.slot, prior: priorTarget });
      if (priorTarget) {
        const priorRelease = path.basename(priorTarget);
        newPrior.push({
          role: c.role,
          slot: c.slot,
          pkg: c.pkg,
          version:
            (await ops.readInstalledVersion(path.join(dir, "releases", priorRelease), c.pkg)) ??
            "unknown",
          release: priorRelease
        });
      }
    }
    if (binary !== undefined && expected !== undefined) {
      await ops.ensureBinSymlink(provider, binary);
      const actual = await sha512OfResolved(ops.binPath(binary));
      if (!hashEq(actual, expected)) {
        await undo();
        return { state: "error", message: "post-promote integrity check failed" };
      }
      ops.pinHash(provider, expected);
    }
  } catch (err) {
    await undo();
    return { state: "error", message: redactInstallMessage(err) };
  }
  await writeToolsState(ops.toolsPrefix, provider, {
    ...state,
    candidate: [],
    prior: newPrior
  });
  // The previous generation of `prior` is no longer rollback material.
  for (const old of state.prior) {
    if (!newPrior.some((n) => n.slot === old.slot && n.release === old.release)) {
      await removeReleaseIfFree(ops, old.slot, old.release);
    }
  }
  return { state: "promoted" };
}

/** Candidate form of the adapter install: same checks as `ensureAdapter`, no flip. */
async function stageAdapter(
  ops: CandidateOps,
  adapter: AdapterRecipe,
  p: CandidatePackage,
  onStaged: (dir: string) => void
): Promise<string | null> {
  const fail = (why: string): string => `chat adapter ${adapter.pkg}: ${why}`;
  const staging = await ops.mkStaging(adapter.slot);
  try {
    await writeFile(path.join(staging, "npm-shrinkwrap.json"), p.lockfileText, "utf8");
    await writeFile(
      path.join(staging, "package.json"),
      JSON.stringify({
        name: "jarv1s-cli-install",
        version: "0.0.0",
        dependencies: { [adapter.pkg]: p.version }
      }),
      "utf8"
    );
    const ci = await ops.io.run(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging],
      { cwd: staging, env: ops.installerEnv }
    );
    if (ci.code !== 0) return fail(redactNpm(`npm ci failed: ${ci.stderr ?? ""}`));
    if ((await ops.readInstalledVersion(staging, adapter.pkg)) !== p.version) {
      return fail("installed version is not the requested version");
    }
    if (!(await pathExists(path.join(staging, adapter.entry)))) return fail("entry file missing");
    onStaged(await ops.stageNpmRelease(adapter.slot, staging));
    return null;
  } catch (err) {
    return fail(redactInstallMessage(err));
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The one cleanup rule. A release stays when it is live, a staged candidate, the previous
 * release, or has a live lease. Anything in doubt stays.
 */
async function releaseIsKept(
  ops: CandidateOps,
  slot: string,
  release: string,
  live: string | undefined,
  keep: ReadonlySet<string>
): Promise<boolean> {
  const dir = path.join(ops.toolsPrefix, "providers", slot, "releases", release);
  if (dir === live || keep.has(dir)) return true;
  return hasLiveLease(ops.toolsPrefix, { slot, release }).catch(() => true);
}

/** Deletes one release unless the shared rule keeps it. */
export async function removeReleaseIfFree(
  ops: CandidateOps,
  slot: string,
  release: string
): Promise<void> {
  const live = await ops.resolveCurrent(slot);
  const keep = await candidateReleaseDirs(ops);
  if (await releaseIsKept(ops, slot, release, live, keep)) return;
  await rm(path.join(ops.toolsPrefix, "providers", slot, "releases", release), {
    recursive: true,
    force: true
  }).catch(() => undefined);
}

/** Absolute release folders that any provider's `state.json` lists as a staged candidate. */
async function candidateReleaseDirs(ops: CandidateOps): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const provider of Object.keys(ops.catalog)) {
    const state = await readToolsState(ops.toolsPrefix, provider);
    for (const c of [...state.candidate, ...state.prior]) {
      keep.add(path.join(ops.toolsPrefix, "providers", c.slot, "releases", c.release));
    }
  }
  return keep;
}

/** GC every `releases/<rand>` NOT the just-promoted dir AND not the live target (§A.3.2). */
export async function gcOldReleases(
  ops: CandidateOps,
  provider: string,
  keepDir?: string
): Promise<void> {
  const providerDir = path.join(ops.toolsPrefix, "providers", provider);
  const releasesDir = path.join(providerDir, "releases");
  const live = await ops.resolveCurrent(provider);
  const keep = await candidateReleaseDirs(ops);
  const listed = await ops.io.run("ls", ["-A", releasesDir]).catch(() => ({ code: 1, stdout: "" }));
  if (listed.code !== 0) return;
  for (const name of splitLines(listed.stdout)) {
    const dir = path.join(releasesDir, name);
    if (dir === keepDir || (await releaseIsKept(ops, provider, name, live, keep))) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function toolsStateSummary(toolsPrefix: string): Promise<RpcGetCliToolsStateResult> {
  const candidates: {
    -readonly [K in RpcProviderKind]: RpcGetCliToolsStateResult["candidates"][K][number][];
  } = {
    anthropic: [],
    "openai-compatible": [],
    google: []
  };
  const lastCheck: Record<RpcProviderKind, RpcCliLastCheck | null> = {
    anthropic: null,
    "openai-compatible": null,
    google: null
  };
  let manifestSequence = 0;
  for (const provider of Object.keys(candidates) as RpcProviderKind[]) {
    const state = await readToolsState(toolsPrefix, provider);
    lastCheck[provider] = state.lastCheck ?? null;
    manifestSequence = Math.max(manifestSequence, state.manifestSequence);
    candidates[provider] = state.candidate.map((c) => ({
      pkg: c.pkg,
      version: c.version,
      role: c.role
    }));
  }
  return { manifestSequence, candidates, lastCheck };
}

/** Runs the cleanup rule over one slot. */
export async function sweepReleases(ops: CandidateOps, provider: string): Promise<void> {
  await gcOldReleases(ops, provider);
}
