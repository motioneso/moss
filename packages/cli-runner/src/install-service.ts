/**
 * §A.3 INSTALL SERVICE — the supply-chain core of the on-demand installer.
 *
 * Performs a provider install entirely INSIDE the cli-runner sidecar, under a
 * sanitized INSTALLER env (the §7.2 CLI allowlist PLUS only the non-secret
 * registry/proxy vars an npm install needs — §A.3.3; NO app/db/vault/RPC secrets).
 * Installs into the tools volume (`/data/cli-tools`).
 *
 * The frozen invariants (all enforced here):
 *  - §A.3.1 per-provider SERIALIZE lock — a separate Mutex instance per provider,
 *    DISTINCT from the §4.1.0a admission mutex; concurrent same-provider ⇒ bad_request.
 *  - §A.3.2 stage into an EPHEMERAL `.staging` scratch on the SAME fs as the tools
 *    volume; promote `rename`s the verified tree into a DURABLE
 *    `providers/<provider>/releases/<rand>` lane; `current` NEVER points into `.staging`.
 *  - §A.3.3 npm path = `npm ci --ignore-scripts` against the committed lockfile (block
 *    lifecycle scripts); codex/claude native binary resolved EXPLICITLY per-arch.
 *  - §A.3.4 VERIFY-before-promote: binary exists+exec, resolved version == recipe
 *    version, lockfile integrity (npm ci), pin a SHA512 over the promote target; TOCTOU
 *    close = RE-VERIFY the hash immediately AFTER promote.
 *  - §A.3.5 ATOMIC promote (one form per kind); ROLLBACK on any failure incl. a
 *    post-promote re-hash mismatch (flip `current` back, prior install intact).
 *  - §A.3.6 IDEMPOTENT: a re-install of the pinned version re-hashes the on-disk bytes
 *    and no-ops with `alreadyInstalled` ONLY when the hash AND `--version` match.
 *  - §A.3.7 self-update disabled via the recipe's concrete `selfUpdateDisable`
 *    (kind:"config" = a file write at install; kind:"env" wiring lives in main.ts).
 *
 * A FAILED install is a TERMINAL OUTCOME — `{ state:"error", message }` (NOT a thrown
 * RpcErr). The service only throws for the in-flight-lock rejection (mapped to
 * bad_request by the dispatcher) and would surface an unexpected fault as `internal`.
 */

import {
  readToolsState,
  writeToolsState,
  type LastCheck,
  type StagedPackage
} from "./tools-state.js";
import { hasLiveLease } from "./tools-leases.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { arch as osArch } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import type { TmuxIo } from "@moss/ai";

import type {
  InstallRecipe,
  NpmInstallRecipe,
  ProviderCatalog,
  RpcInstallProviderResult,
  RpcListCliToolVersionsResult,
  RpcCliLastCheck,
  RpcGetCliToolsStateResult,
  RpcProviderKind
} from "@moss/chat/live";

import { ADAPTER_CATALOG, findRepoRoot, type AdapterRecipe } from "./catalog.js";
import { readOpenCodeVersion } from "./opencode-version.js";
import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { Mutex } from "./mutex.js";
import { resolveDefaultToolsPrefix } from "./tools-prefix.js";

// ─── Errors the dispatcher maps (§A.2.3) ──────────────────────────────────────

/**
 * A re-entrant install of an in-flight provider, or a blocked/unknown provider —
 * mapped to RpcErr `bad_request` by connection.ts (does NOT close the connection).
 * Distinct from the failed-install OUTCOME (which is an RpcOk `{state:"error"}`).
 */
export class InstallBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallBadRequestError";
  }
}

// ─── Installer-env allowlist (§A.3.3 — §7.2 PLUS registry/proxy, NO secrets) ──

/**
 * The non-secret network-config keys a legitimate npm install needs in a
 * proxied/mirrored deploy, layered OVER the §7.2 CLI-subprocess allowlist. NOTHING
 * secret is added (no BETTER_AUTH_SECRET / JARVIS_AI_SECRET_KEY / DB URLs / vault /
 * RPC secret / socket path — §A.3.3, §A.6.2 "Installer-env allowlist").
 */
const INSTALLER_EXTRA_KEYS: readonly string[] = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NPM_CONFIG_REGISTRY"
];

/**
 * Build the installer subprocess env: the §7.2 CLI allowlist (deny-by-default) PLUS
 * only the §A.3.3 registry/proxy vars. Same posture as `buildSanitizedCliEnv` —
 * everything else (every app/DB/vault/RPC secret + the socket path) is dropped.
 */
export function buildSanitizedInstallerEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out = buildSanitizedCliEnv(source);
  for (const key of INSTALLER_EXTRA_KEYS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** One package of a toolset the manifest wants staged. The lockfile text is already hash-checked. */
export interface CandidatePackage {
  readonly role: "cli" | "chat-adapter";
  readonly pkg: string;
  readonly version: string;
  readonly lockfileText: string;
}

interface CandidateInstall {
  readonly lockfileText: string;
  readonly onStaged: (releaseDir: string) => void;
}

export type PromoteCandidateResult =
  | { readonly state: "promoted" }
  | { readonly state: "error"; readonly message: string };

export type StageCandidateResult =
  | { readonly state: "staged"; readonly staged: readonly StagedPackage[] }
  | { readonly state: "error"; readonly message: string };

export interface InstallServiceDeps {
  /** The execFile-style runner (NOT a shell); reuses the cli-runner discipline. */
  readonly io: TmuxIo;
  /** The validated allowlist (§A.1). Consumed read-only — never mutated here. */
  readonly catalog: ProviderCatalog;
  /** Tools-volume prefix (`NPM_CONFIG_PREFIX`, base §7.1). Default `/data/cli-tools`. */
  readonly toolsPrefix?: string;
  /** HOME base for kind:"config" self-update writes (`CODEX_HOME` parent). Default `/data/cli-auth`. */
  readonly homeBase?: string;
  /** Source env the installer subprocess is derived from (§A.3.3). Default process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Bound the whole resolve→verify→promote sequence (§A.3.1). Default generous. */
  readonly installTimeoutMs?: number;
  /** Override host arch (tests). Default `os.arch()`. */
  readonly hostArch?: string;
  /** Chat adapter recipes by provider (#2689). Default `ADAPTER_CATALOG`. */
  readonly adapterCatalog?: Partial<Record<RpcProviderKind, AdapterRecipe>>;
}

const DEFAULT_HOME_BASE = "/data/cli-auth";
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

/** os.arch() → the archBinaryPackage key. An arch with no entry is a DEFINED verify failure (§A.1.3). */
const ARCH_KEY: Readonly<Record<string, "linux-x64" | "linux-arm64">> = {
  x64: "linux-x64",
  arm64: "linux-arm64"
};

// ─── The service ────────────────────────────────────────────────────────────

export class InstallService {
  private readonly toolsPrefix: string;
  private readonly homeBase: string;
  private readonly installerEnv: NodeJS.ProcessEnv;
  private readonly installTimeoutMs: number;
  private readonly hostArch: string;
  /** §A.3.1 ONE Mutex INSTANCE per provider — distinct from the §4.1.0a admission mutex. */
  private readonly locks = new Map<RpcProviderKind, Mutex>();
  /** §A.3.1 in-flight set — a re-entrant install while held ⇒ bad_request (NOT queued). */
  private readonly inFlight = new Set<RpcProviderKind>();
  /**
   * §A.3.4/§A.3.6 the verify-time SHA512 pinned at the last successful npm install, by
   * provider — so the idempotent re-verify can re-compare ON-DISK bytes (not just
   * --version). (Artifact recipes compare directly against `recipe.sha512`.)
   */
  private readonly pinnedHash = new Map<RpcProviderKind, string>();

  constructor(private readonly deps: InstallServiceDeps) {
    this.toolsPrefix = deps.toolsPrefix ?? resolveDefaultToolsPrefix();
    this.homeBase = deps.homeBase ?? DEFAULT_HOME_BASE;
    this.installerEnv = buildSanitizedInstallerEnv(deps.env ?? process.env);
    this.installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    this.hostArch = deps.hostArch ?? osArch();
  }

  /**
   * #2340: make sure the tools folder exists before anything tries to install or run a
   * provider out of it. Called once at startup; a failure here must not crash the process,
   * since providers already installed elsewhere may still work.
   */
  async ensureToolsPrefixWritable(): Promise<void> {
    try {
      await mkdir(this.toolsPrefix, { recursive: true });
    } catch (cause) {
      throw new Error(
        `could not create the tools folder at ${this.toolsPrefix}: ${(cause as Error).message}`,
        { cause }
      );
    }
  }

  // ─── public entry (called by CliChatEngineHost.installProvider) ─────────────

  /**
   * Resolve + stage + verify + atomically promote the catalog recipe for `provider`.
   * Throws `InstallBadRequestError` for an in-flight / blocked / unknown provider
   * (§A.2.3). Otherwise resolves to a terminal `RpcInstallProviderResult` — a failed
   * install is `{state:"error"}`, NOT a throw (§A.2.3).
   */
  async installProvider(provider: RpcProviderKind): Promise<RpcInstallProviderResult> {
    const recipe = this.resolveRecipe(provider); // throws InstallBadRequestError if blocked

    // §A.3.1 per-provider SERIALIZE: reject (NOT queue) a re-entrant same-provider call.
    // Set `inFlight` SYNCHRONOUSLY (before any await) so the reject decision is atomic in
    // the JS single thread — a second call can never slip past the check into the lock's
    // FIFO queue. The mutex is then a belt-and-suspenders ordering guard.
    if (this.inFlight.has(provider)) {
      throw new InstallBadRequestError("install already in progress");
    }
    this.inFlight.add(provider);
    const release = await this.lockFor(provider).acquire();
    try {
      return await this.withTimeout(this.runInstall(provider, recipe), this.installTimeoutMs);
    } catch (err) {
      // A blocked/in-flight rejection is a bad_request (re-thrown). Every other failure
      // inside runInstall is already caught and returned as {state:"error"}; reaching
      // here means an UNEXPECTED fault (or the timeout) — surface it as a terminal error
      // outcome (the connection survives; the api persists `error`).
      if (err instanceof InstallBadRequestError) throw err;
      return { state: "error", message: redactInstallMessage(err) };
    } finally {
      this.inFlight.delete(provider);
      release();
    }
  }

  /** §A.2.3 catalog-status gate: blocked/absent ⇒ bad_request; only supported reaches install. */
  private resolveRecipe(provider: RpcProviderKind): InstallRecipe {
    const entry = this.deps.catalog[provider];
    if (!entry || entry.status === "blocked" || !entry.recipe) {
      const reason = entry?.blockedReason ?? "not in catalog";
      throw new InstallBadRequestError(`provider not installable: ${reason}`);
    }
    return entry.recipe;
  }

  private lockFor(provider: RpcProviderKind): Mutex {
    let m = this.locks.get(provider);
    if (!m) {
      m = new Mutex();
      this.locks.set(provider, m);
    }
    return m;
  }

  // ─── the install sequence (lock held) ───────────────────────────────────────

  private async runInstall(
    provider: RpcProviderKind,
    recipe: InstallRecipe
  ): Promise<RpcInstallProviderResult> {
    // §A.3.6 IDEMPOTENT: if the pinned version is already live AND the on-disk bytes
    // still match, no-op. A hash mismatch (drifted/tampered) falls through to REINSTALL.
    const cli =
      (await this.tryIdempotentNoop(provider, recipe)) ??
      (recipe.kind === "npm"
        ? await this.installNpm(provider, recipe)
        : await this.installArtifact(provider, recipe));
    if (cli.state !== "installed") return cli;

    // #2689: the provider's chat adapter rides with its CLI. A failure here leaves the CLI in
    // place and chat on the image adapter, but is reported so the admin sees it.
    const adapterError = await this.ensureAdapter(provider);
    return adapterError ? { state: "error", message: adapterError } : cli;
  }

  // ─── #2689 chat adapter install ─────────────────────────────────────────────

  /** Install or confirm the provider's chat adapter. Returns an error message, or null. */
  private async ensureAdapter(provider: RpcProviderKind): Promise<string | null> {
    const adapter = (this.deps.adapterCatalog ?? ADAPTER_CATALOG)[provider];
    if (!adapter) return null;
    const fail = (why: string): string => `chat adapter ${adapter.pkg}: ${why}`;
    const live = await this.resolveCurrent(adapter.slot);
    if (
      live &&
      (await isPublishedNpmRelease(live)) &&
      (await this.readInstalledVersion(live, adapter.pkg)) === adapter.version &&
      (await pathExists(path.join(live, adapter.entry)))
    ) {
      return null;
    }
    const staging = await this.mkStaging(adapter.slot);
    try {
      await writeFile(
        path.join(staging, "npm-shrinkwrap.json"),
        await readFile(this.resolveRepoPath(adapter.lockfile), "utf8"),
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
      const ci = await this.deps.io.run(
        "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging],
        { cwd: staging, env: this.installerEnv }
      );
      if (ci.code !== 0) return fail(redactNpm(`npm ci failed: ${ci.stderr ?? ""}`));
      if ((await this.readInstalledVersion(staging, adapter.pkg)) !== adapter.version) {
        return fail("installed version is not the pinned version");
      }
      if (!(await pathExists(path.join(staging, adapter.entry)))) return fail("entry file missing");
      const release = await this.promoteNpm(adapter.slot, staging, null);
      await this.gcOldReleases(adapter.slot, release.dir);
      return null;
    } catch (err) {
      return fail(redactInstallMessage(err));
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── #2689 slice 4: stage a candidate toolset (current is never touched) ─────

  /**
   * Install each package of a candidate toolset into a new release folder, leaving `current`
   * where it is. Only packages named in this image's catalog are accepted, so a manifest can
   * move versions but never introduce a package. Candidates are recorded in `state.json` so the
   * boot sweep keeps them. Any failure removes what this call staged.
   */
  async stageCandidate(
    provider: RpcProviderKind,
    packages: readonly CandidatePackage[],
    manifestSequence: number
  ): Promise<StageCandidateResult> {
    const release = await this.lockFor(provider).acquire();
    try {
      return await this.stageCandidateLocked(provider, packages, manifestSequence);
    } finally {
      release();
    }
  }

  private async stageCandidateLocked(
    provider: RpcProviderKind,
    packages: readonly CandidatePackage[],
    manifestSequence: number
  ): Promise<StageCandidateResult> {
    {
      if (packages.length === 0) {
        // Nothing newer than live: only record that this manifest was seen. A staged candidate stays.
        const prior = await readToolsState(this.toolsPrefix, provider);
        await writeToolsState(this.toolsPrefix, provider, {
          ...prior,
          manifestSequence: Math.max(prior.manifestSequence, manifestSequence)
        });
        return { state: "staged", staged: prior.candidate };
      }
      const staged: StagedPackage[] = [];
      const cleanup = async (): Promise<void> => {
        for (const s of staged) {
          await rm(path.join(this.toolsPrefix, "providers", s.slot, "releases", s.release), {
            recursive: true,
            force: true
          }).catch(() => undefined);
        }
      };
      try {
        const adapter = (this.deps.adapterCatalog ?? ADAPTER_CATALOG)[provider];
        for (const p of packages) {
          let slot: string;
          let error: string | null;
          let release: string | undefined;
          const onStaged = (dir: string): void => {
            release = path.basename(dir);
          };
          if (p.role === "cli") {
            const recipe = this.resolveRecipe(provider);
            if (recipe.kind !== "npm" || recipe.pkg !== p.pkg) {
              await cleanup();
              return { state: "error", message: `package ${p.pkg} is not installable here` };
            }
            slot = provider;
            const r = await this.installNpm(
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
            error = await this.stageAdapter(adapter, p, onStaged);
          }
          if (error !== null || release === undefined) {
            await cleanup();
            return { state: "error", message: error ?? "nothing was staged" };
          }
          staged.push({ role: p.role, slot, pkg: p.pkg, version: p.version, release });
        }
        const prior = await readToolsState(this.toolsPrefix, provider);
        // Replacing an older candidate frees its releases for the next sweep.
        // A new candidate has not been checked yet, so the last check is dropped.
        const { lastCheck: _dropped, ...kept } = prior;
        await writeToolsState(this.toolsPrefix, provider, {
          ...kept,
          manifestSequence: Math.max(prior.manifestSequence, manifestSequence),
          candidate: staged
        });
        for (const old of prior.candidate) {
          if (!staged.some((s) => s.slot === old.slot && s.release === old.release)) {
            await this.removeReleaseIfFree(old.slot, old.release);
          }
        }
        return { state: "staged", staged };
      } catch (err) {
        await cleanup();
        return { state: "error", message: redactInstallMessage(err) };
      }
    }
  }

  /**
   * Make the staged candidate the live toolset: flip `current` for every package, re-hash the
   * live binary, and keep the releases that were live as `prior` until the next promote. A hash
   * mismatch flips everything back. Only a toolset with a staged candidate can be promoted.
   */
  async promoteCandidate(provider: RpcProviderKind): Promise<PromoteCandidateResult> {
    const release = await this.lockFor(provider).acquire();
    try {
      return await this.promoteCandidateLocked(provider);
    } finally {
      release();
    }
  }

  private async promoteCandidateLocked(provider: RpcProviderKind): Promise<PromoteCandidateResult> {
    const state = await readToolsState(this.toolsPrefix, provider);
    if (state.candidate.length === 0) return { state: "error", message: "no staged candidate" };
    const flipped: { slot: string; prior: string | undefined }[] = [];
    const newPrior: StagedPackage[] = [];
    const undo = async (): Promise<void> => {
      for (const f of flipped.reverse()) {
        if (!f.prior) continue;
        const dir = path.join(this.toolsPrefix, "providers", f.slot);
        const tmp = path.join(dir, `.current-${randToken()}`);
        await symlink(f.prior, tmp).catch(() => undefined);
        await rename(tmp, path.join(dir, "current")).catch(() => undefined);
      }
    };
    try {
      let expected: string | undefined;
      let binary: string | undefined;
      for (const c of state.candidate) {
        const dir = path.join(this.toolsPrefix, "providers", c.slot);
        const releaseDir = path.join(dir, "releases", c.release);
        if (c.role === "cli") {
          const recipe = this.resolveRecipe(provider);
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
              (await this.readInstalledVersion(path.join(dir, "releases", priorRelease), c.pkg)) ??
              "unknown",
            release: priorRelease
          });
        }
      }
      if (binary !== undefined && expected !== undefined) {
        await this.ensureBinSymlink(provider, binary);
        const actual = await sha512OfResolved(this.binPath(binary));
        if (!hashEq(actual, expected)) {
          await undo();
          return { state: "error", message: "post-promote integrity check failed" };
        }
        this.pinnedHash.set(provider, expected);
      }
    } catch (err) {
      await undo();
      return { state: "error", message: redactInstallMessage(err) };
    }
    await writeToolsState(this.toolsPrefix, provider, {
      ...state,
      candidate: [],
      prior: newPrior
    });
    // The previous generation of `prior` is no longer rollback material.
    for (const old of state.prior) {
      if (!newPrior.some((n) => n.slot === old.slot && n.release === old.release)) {
        await this.removeReleaseIfFree(old.slot, old.release);
      }
    }
    return { state: "promoted" };
  }

  /** Record the outcome of the last live check in `state.json`. */
  async recordCheck(provider: RpcProviderKind, check: LastCheck): Promise<void> {
    const release = await this.lockFor(provider).acquire();
    try {
      const state = await readToolsState(this.toolsPrefix, provider);
      await writeToolsState(this.toolsPrefix, provider, { ...state, lastCheck: check });
    } finally {
      release();
    }
  }

  /** Candidate form of the adapter install: same checks as `ensureAdapter`, no flip. */
  private async stageAdapter(
    adapter: AdapterRecipe,
    p: CandidatePackage,
    onStaged: (dir: string) => void
  ): Promise<string | null> {
    const fail = (why: string): string => `chat adapter ${adapter.pkg}: ${why}`;
    const staging = await this.mkStaging(adapter.slot);
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
      const ci = await this.deps.io.run(
        "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging],
        { cwd: staging, env: this.installerEnv }
      );
      if (ci.code !== 0) return fail(redactNpm(`npm ci failed: ${ci.stderr ?? ""}`));
      if ((await this.readInstalledVersion(staging, adapter.pkg)) !== p.version) {
        return fail("installed version is not the requested version");
      }
      if (!(await pathExists(path.join(staging, adapter.entry)))) return fail("entry file missing");
      onStaged(await this.stageNpmRelease(adapter.slot, staging));
      return null;
    } catch (err) {
      return fail(redactInstallMessage(err));
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── npm path (§A.3.3/§A.3.4/§A.3.5) ────────────────────────────────────────

  private async installNpm(
    provider: RpcProviderKind,
    recipe: NpmInstallRecipe,
    candidate?: CandidateInstall
  ): Promise<RpcInstallProviderResult> {
    // §A.1.3: resolve the host-arch key BEFORE staging — a missing entry is a DEFINED
    // verify failure, never an undefined deref.
    let archPkg: string | undefined;
    if (recipe.archOptionalDeps) {
      const key = ARCH_KEY[this.hostArch];
      if (!key || !recipe.archBinaryPackage?.[key]) {
        return {
          state: "error",
          message: `unsupported host arch "${this.hostArch}" — no per-arch native binary`
        };
      }
      archPkg = recipe.archBinaryPackage[key];
    }

    const staging = await this.mkStaging(provider);
    try {
      // (1) Stage: copy the COMMITTED lockfile + a minimal package.json into staging.
      // A candidate install takes the lockfile from the signed manifest instead.
      const lockRaw = candidate
        ? candidate.lockfileText
        : await readFile(this.resolveRepoPath(recipe.lockfile), "utf8");
      await writeFile(path.join(staging, "npm-shrinkwrap.json"), lockRaw, "utf8");
      await writeFile(
        path.join(staging, "package.json"),
        JSON.stringify(
          {
            name: "jarv1s-cli-install",
            version: "0.0.0",
            dependencies: { [recipe.pkg]: recipe.version }
          },
          null,
          2
        ),
        "utf8"
      );

      // (2) `npm ci --ignore-scripts` — enforces the lockfile EXACTLY (full-tree sha512)
      // and blocks every lifecycle script. NOT a shell string — execFile-style args.
      const ci = await this.deps.io.run(
        "npm",
        ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", staging],
        { cwd: staging, env: this.installerEnv }
      );
      if (ci.code !== 0) {
        return { state: "error", message: redactNpm(`npm ci failed: ${ci.stderr ?? ""}`) };
      }

      // (2b) §A.1.3 EXPLICIT native-binary placement, AFTER `npm ci` and BEFORE verify, for a
      // recipe whose main-package bin wrapper is a STUB (claude). The package's postinstall
      // (skipped by --ignore-scripts) would copy the per-arch native binary over the wrapper;
      // we replicate ONLY that file placement DETERMINISTICALLY (never run the script). codex
      // omits archBinaryPlacement (its wrapper self-resolves at runtime).
      if (recipe.archBinaryPlacement && archPkg) {
        const placeErr = await this.placeArchBinary(staging, recipe, archPkg);
        if (placeErr) return { state: "error", message: placeErr };
      }

      // (3) VERIFY before promote (§A.3.4). The staged tree under `npm ci --prefix` lands
      // packages under <staging>/node_modules and bins under <staging>/node_modules/.bin.
      const stagedBin = path.join(staging, "node_modules", ".bin", recipe.binary);
      const verifyErr = await this.verifyNpmStaged(staging, stagedBin, recipe, archPkg);
      if (verifyErr) return { state: "error", message: verifyErr };

      // §A.3.4 TOCTOU close: pin a SHA512 over the EXACT promote target (the resolved
      // bin, dereferencing the .bin symlink) at verify time.
      const verifyHash = await sha512OfResolved(stagedBin);

      // (4) §A.3.7 kind:"config" self-update-disable is a FILE WRITE at install
      // (kind:"env" is wired in main.ts; nothing to write here).
      await this.writeSelfUpdateConfig(recipe);

      // A candidate stops here: it is renamed into a release folder and `current` stays put.
      if (candidate) {
        candidate.onStaged(await this.stageNpmRelease(provider, staging));
        return { state: "installed", version: recipe.version, binaryChanged: false };
      }

      // (5) ATOMIC PROMOTE (§A.3.5): rename the verified tree into a DURABLE release lane,
      // then flip `current`; create the stable bin symlink once.
      const release = await this.promoteNpm(provider, staging, recipe.binary);

      // §A.3.4 re-verify the post-promote hash (TOCTOU). The live bin resolves THROUGH
      // providers/<provider>/current → releases/<rand>.
      const liveBin = this.binPath(recipe.binary);
      const postHash = await sha512OfResolved(liveBin);
      if (!hashEq(postHash, verifyHash)) {
        // The promote did not place the exact verified bytes — roll back the flip.
        await this.rollbackNpmPromote(provider, release);
        return { state: "error", message: "post-promote integrity check failed" };
      }
      this.pinnedHash.set(provider, verifyHash);

      // GC the SUPERSEDED prior release (never the just-promoted one, §A.3.2).
      await this.gcOldReleases(provider, release.dir);

      // #1081 H2: this branch only runs when tryIdempotentNoop returned null (a real
      // reinstall) — binaryChanged:true tells callers the on-disk binary was replaced.
      return { state: "installed", version: recipe.version, binaryChanged: true };
    } catch (err) {
      return { state: "error", message: redactInstallMessage(err) };
    } finally {
      // §A.3.2: the ephemeral staging scratch is removed on success (its tree was
      // rename'd OUT) AND on failure (rollback).
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * §A.1.3 EXPLICIT native-binary placement for a stub-wrapper recipe (claude). Replaces
   * `<staging>/node_modules/<pkg>/<wrapperRelPath>` with the per-arch package's native binary
   * `<staging>/node_modules/<archPkg>/<archBinaryFile>` — DETERMINISTICALLY replicating ONLY
   * the file placement the package's (script-blocked) postinstall would do, never running it.
   *
   * PREFERS a RELATIVE symlink dest → src so the 233MB binary is not duplicated: both live in
   * the same staged node_modules, move together on the atomic promote rename (§A.3.5), and the
   * verify-time `sha512OfResolved` (and `--version` exec) dereference the symlink. The dest is
   * chmod 0o755 so the §A.3.4 `isExecutable` verify passes (symlink mode follows the target,
   * which is already executable in the arch package, but chmod is harmless + explicit). Returns
   * an error message (a verify failure) or null.
   */
  private async placeArchBinary(
    staging: string,
    recipe: NpmInstallRecipe,
    archPkg: string
  ): Promise<string | null> {
    const placement = recipe.archBinaryPlacement;
    if (!placement) return null;
    const nm = path.join(staging, "node_modules");
    const src = path.join(nm, archPkg, placement.archBinaryFile);
    const dest = path.join(nm, recipe.pkg, placement.wrapperRelPath);

    // The per-arch native binary MUST be present (npm ci materialized the lockfile-pinned dep).
    if (!(await pathExists(src))) {
      return `per-arch native binary "${placement.archBinaryFile}" not found in "${archPkg}"`;
    }
    // Replace the stub wrapper with a RELATIVE symlink to the native binary (avoids a 466MB
    // duplicate). Remove the existing wrapper first (it is a real file npm ci wrote).
    await rm(dest, { force: true }).catch(() => undefined);
    await mkdir(path.dirname(dest), { recursive: true });
    const relTarget = path.relative(path.dirname(dest), src);
    try {
      await symlink(relTarget, dest);
    } catch (err) {
      return `native-binary placement failed: ${redactInstallMessage(err)}`;
    }
    // chmod the resolved target so isExecutable() (which stat-follows the symlink) sees +x.
    await chmod(dest, 0o755).catch(() => undefined);
    return null;
  }

  /** §A.3.4 npm verify: binary present+exec, resolved version == recipe, --version matches, arch dep present. */
  private async verifyNpmStaged(
    staging: string,
    stagedBin: string,
    recipe: NpmInstallRecipe,
    archPkg: string | undefined
  ): Promise<string | null> {
    // binary exists + executable
    if (!(await isExecutable(stagedBin))) {
      return `installed package produced no executable "${recipe.binary}"`;
    }
    // resolved package version in the staged tree == recipe.version
    const installedVersion = await this.readInstalledVersion(staging, recipe.pkg);
    if (installedVersion !== recipe.version) {
      return `resolved version "${installedVersion ?? "?"}" != pinned "${recipe.version}"`;
    }
    // §A.1.3: the per-arch native package was materialized by npm ci (lockfile-pinned).
    if (archPkg) {
      const archDir = path.join(staging, "node_modules", archPkg);
      if (!(await pathExists(archDir))) {
        return `per-arch native binary package "${archPkg}" not present after npm ci`;
      }
    }
    // the binary's own --version matches the pinned version (the §A.5 re-probe target).
    const probe = await this.deps.io.run(stagedBin, ["--version"], { env: this.installerEnv });
    if (probe.code !== 0 || !probe.stdout.includes(recipe.version)) {
      return `"${recipe.binary} --version" did not report the pinned version`;
    }
    return null;
  }

  /** Read the installed package's version from the staged node_modules tree. */
  private async readInstalledVersion(staging: string, pkg: string): Promise<string | undefined> {
    try {
      const pj = await readFile(path.join(staging, "node_modules", pkg, "package.json"), "utf8");
      const v = (JSON.parse(pj) as { version?: unknown }).version;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Rename a verified staging tree into a durable `providers/<provider>/releases/<rand>` lane
   * without touching `current`. A candidate toolset stops here; a promote continues to the flip.
   */
  private async stageNpmRelease(provider: string, staging: string): Promise<string> {
    const providerDir = path.join(this.toolsPrefix, "providers", provider);
    const releasesDir = path.join(providerDir, "releases");
    await mkdir(releasesDir, { recursive: true });
    const releaseDir = path.join(releasesDir, randToken());
    // Keep the staging tree private until verification is complete, then make only the
    // published release root traversable by isolated accounts. A chmod failure aborts
    // before the atomic same-filesystem rename.
    await chmod(staging, 0o755);
    await rename(staging, releaseDir);
    return releaseDir;
  }

  /**
   * §A.3.5 npm promote: rename the verified staged tree into a DURABLE
   * `providers/<provider>/releases/<rand>` lane (same-fs, atomic), then flip
   * `providers/<provider>/current → releases/<rand>` via temp-symlink-rename. The stable
   * `bin/<binary>` symlink (resolving THROUGH current) is created ONCE on first install.
   */
  private async promoteNpm(
    provider: string,
    staging: string,
    binary: string | null
  ): Promise<{ dir: string; prior: string | undefined }> {
    const providerDir = path.join(this.toolsPrefix, "providers", provider);
    const releaseDir = await this.stageNpmRelease(provider, staging);

    const currentLink = path.join(providerDir, "current");
    const prior = await readlink(currentLink).catch(() => undefined);

    // Flip `current` → releases/<rand> atomically (temp symlink in the SAME dir, rename).
    const tmpLink = path.join(providerDir, `.current-${randToken()}`);
    await symlink(path.join("releases", path.basename(releaseDir)), tmpLink);
    await rename(tmpLink, currentLink);

    // Stable PATH bin symlink, created ONCE: bin/<binary> → ../providers/<provider>/current/node_modules/.bin/<binary>.
    if (binary) await this.ensureBinSymlink(provider, binary);

    return {
      dir: releaseDir,
      prior: prior ? path.resolve(providerDir, prior) : undefined
    };
  }

  /** Flip `current` back to the prior release and remove the just-promoted bad release (§A.3.5). */
  private async rollbackNpmPromote(
    provider: string,
    release: { dir: string; prior: string | undefined }
  ): Promise<void> {
    const providerDir = path.join(this.toolsPrefix, "providers", provider);
    const currentLink = path.join(providerDir, "current");
    if (release.prior) {
      const tmpLink = path.join(providerDir, `.current-${randToken()}`);
      await symlink(path.relative(providerDir, release.prior), tmpLink).catch(() => undefined);
      await rename(tmpLink, currentLink).catch(() => undefined);
    }
    await rm(release.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** GC every `releases/<rand>` NOT the just-promoted dir AND not the live target (§A.3.2). */
  private async gcOldReleases(provider: string, keepDir: string): Promise<void> {
    const providerDir = path.join(this.toolsPrefix, "providers", provider);
    const releasesDir = path.join(providerDir, "releases");
    const live = await this.resolveCurrent(provider);
    const keep = await this.candidateReleaseDirs();
    const listed = await this.deps.io
      .run("ls", ["-A", releasesDir])
      .catch(() => ({ code: 1, stdout: "" }));
    if (listed.code !== 0) return;
    for (const name of splitLines(listed.stdout)) {
      const dir = path.join(releasesDir, name);
      if (dir === keepDir || (await this.releaseIsKept(provider, name, live, keep))) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── artifact path (§A.3.4/§A.3.5) ──────────────────────────────────────────

  private async installArtifact(
    provider: RpcProviderKind,
    recipe: Extract<InstallRecipe, { kind: "artifact" }>
  ): Promise<RpcInstallProviderResult> {
    const staging = await this.mkStaging(provider);
    try {
      const dl = path.join(staging, recipe.binary);
      // Fetch the PINNED versioned URL over HTTPS (no fetch-and-run); verify BEFORE exec.
      const fetched = await this.fetchArtifact(recipe.url, dl);
      if (fetched) return { state: "error", message: fetched };

      // §A.3.4 SHA512 verify (constant-time) BEFORE the binary is ever executable.
      const got = await sha512OfFile(dl);
      if (!hashEq(got, recipe.sha512)) {
        return { state: "error", message: "artifact SHA512 mismatch" };
      }
      await chmod(dl, 0o755);
      const probe = await this.deps.io.run(dl, ["--version"], { env: this.installerEnv });
      if (probe.code !== 0 || !probe.stdout.includes(recipe.version)) {
        return { state: "error", message: `"${recipe.binary} --version" mismatch` };
      }

      await this.writeSelfUpdateConfig(recipe);

      // §A.3.5 atomic rename of the verified binary onto its live provider path; stable bin symlink.
      const providerDir = path.join(this.toolsPrefix, "providers", provider);
      await mkdir(providerDir, { recursive: true });
      const livePath = path.join(providerDir, recipe.binary);
      const prior = (await pathExists(livePath))
        ? await sha512OfFile(livePath).catch(() => undefined)
        : undefined;
      await rename(dl, livePath);
      await this.ensureArtifactBinSymlink(provider, recipe.binary);

      // TOCTOU: re-verify the live bytes equal the pinned sha512.
      const postHash = await sha512OfFile(livePath);
      if (!hashEq(postHash, recipe.sha512)) {
        // Roll back to the prior bytes if we had them; else remove the bad binary.
        if (prior === undefined) await rm(livePath, { force: true }).catch(() => undefined);
        return { state: "error", message: "post-promote integrity check failed" };
      }
      this.pinnedHash.set(provider, recipe.sha512);
      // #1081 H2: reached only on a real reinstall (tryIdempotentNoop returned null).
      return { state: "installed", version: recipe.version, binaryChanged: true };
    } catch (err) {
      return { state: "error", message: redactInstallMessage(err) };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Download a pinned HTTPS artifact to `dest`. Returns an error message or null. */
  private async fetchArtifact(url: string, dest: string): Promise<string | null> {
    if (!url.startsWith("https:")) return "artifact url is not https";
    try {
      const res = await fetch(url, { redirect: "error" });
      if (!res.ok || !res.body) return `artifact download failed (HTTP ${res.status})`;
      // Reject a cross-host redirect implicitly via redirect:"error" above.
      const out = createWriteStreamSafe(dest);
      // node:stream/promises pipeline accepts a web ReadableStream as the source at
      // runtime; the cast bridges the lib.dom vs node stream typings.
      await pipeline(res.body as unknown as NodeJS.ReadableStream, out);
      return null;
    } catch (err) {
      return redactInstallMessage(err);
    }
  }

  // ─── idempotency (§A.3.6) ───────────────────────────────────────────────────

  /**
   * §A.3.6: a re-install of the already-pinned version is a no-op safe re-verify ONLY
   * when the LIVE binary's on-disk SHA512 matches the recipe/pinned hash AND --version
   * matches. A hash mismatch ⇒ NOT a no-op (return null ⇒ reinstall).
   */
  private async tryIdempotentNoop(
    provider: RpcProviderKind,
    recipe: InstallRecipe
  ): Promise<RpcInstallProviderResult | null> {
    const liveBin = this.binPath(recipe.binary);
    if (!(await isExecutable(liveBin))) return null;

    if (recipe.kind === "npm") {
      const release = await this.resolveCurrent(provider);
      if (!release || !(await isPublishedNpmRelease(release))) return null;
    }

    const probe = await this.deps.io.run(liveBin, ["--version"], { env: this.installerEnv });
    if (probe.code !== 0) return null;
    if (!probe.stdout.includes(recipe.version)) {
      // Image floor (spec 6.2): a live release that an update promoted is newer than the image
      // pin. Keep it instead of reinstalling the older pin over it.
      const newer = await this.promotedNewerThan(provider, recipe, probe.stdout);
      if (newer === null) return null;
      return { state: "installed", version: newer, alreadyInstalled: true, binaryChanged: false };
    }

    // Re-compute the live on-disk hash and compare to the expectation.
    let expected: string | undefined;
    if (recipe.kind === "artifact") {
      expected = recipe.sha512;
    } else {
      // npm: compare against the verify-time hash pinned at the last successful install.
      expected = this.pinnedHash.get(provider);
      // If we have no pinned hash (fresh process), we cannot prove byte-identity — fall
      // through to a full reinstall (safe; the atomic promote is idempotent on bytes).
      if (!expected) return null;
    }
    const got =
      recipe.kind === "artifact" ? await sha512OfFile(liveBin) : await sha512OfResolved(liveBin);
    if (!hashEq(got, expected)) return null; // drifted/tampered ⇒ reinstall

    // #1081 H2: binaryChanged:false is explicit (not omitted) — nothing on disk changed.
    return {
      state: "installed",
      version: recipe.version,
      alreadyInstalled: true,
      binaryChanged: false
    };
  }

  /**
   * The live version when this provider was promoted by an update (state records a prior release)
   * and the live version is newer than the image pin. Otherwise null.
   */
  private async promotedNewerThan(
    provider: RpcProviderKind,
    recipe: InstallRecipe,
    versionOutput: string
  ): Promise<string | null> {
    if (recipe.kind !== "npm") return null;
    const live = /(\d+\.\d+\.\d+)/.exec(versionOutput)?.[1];
    const pin = /^(\d+)\.(\d+)\.(\d+)/.exec(recipe.version);
    if (!live || !pin) return null;
    const a = live.split(".").map(Number);
    const b = pin.slice(1, 4).map(Number);
    const newer = [0, 1, 2].reduce((r, i) => (r !== 0 ? r : Math.sign(a[i]! - b[i]!)), 0) > 0;
    if (!newer) return null;
    const state = await readToolsState(this.toolsPrefix, provider);
    return state.prior.length > 0 ? live : null;
  }

  // ─── §A.3.7 kind:"config" self-update-disable (file write at install) ────────

  private async writeSelfUpdateConfig(recipe: InstallRecipe): Promise<void> {
    const sud = recipe.selfUpdateDisable;
    if (sud.kind !== "config") return; // kind:"env" is wired in main.ts, not here.
    // The config path is HOME-relative (e.g. ".codex/config.toml"); write under homeBase.
    const target = path.resolve(this.homeBase, sud.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, sud.content, { encoding: "utf8" });
  }

  // ─── startup sweep (§A.3.2 — install-service-owned; called from main.ts boot) ─

  /**
   * §A.3.2 startup sweep (DISTINCT from the engine-host neutral-base auth-volume sweep):
   * (1) clear orphaned `/data/cli-tools/.staging/*`, and (2) GC any
   * `providers/<provider>/releases/<rand>` NOT referenced by that provider's `current`
   * symlink (a crash between the release-rename and the current-flip can orphan one).
   * Runs BEFORE the first `installProvider` is accepted.
   */
  async startupSweep(): Promise<void> {
    // (1) clear the ephemeral staging scratch wholesale.
    const stagingRoot = path.join(this.toolsPrefix, ".staging");
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);

    // (2) per-provider: GC releases not referenced by `current`.
    for (const provider of Object.keys(this.deps.catalog) as RpcProviderKind[]) {
      await this.sweepReleases(provider).catch(() => undefined);
    }
    for (const adapter of Object.values(this.deps.adapterCatalog ?? ADAPTER_CATALOG)) {
      await this.sweepReleases(adapter.slot).catch(() => undefined);
    }
  }

  /**
   * The one cleanup rule. A release stays when it is live, a staged candidate, the previous
   * release, or has a live lease. Anything in doubt stays.
   */
  private async releaseIsKept(
    slot: string,
    release: string,
    live: string | undefined,
    keep: ReadonlySet<string>
  ): Promise<boolean> {
    const dir = path.join(this.toolsPrefix, "providers", slot, "releases", release);
    if (dir === live || keep.has(dir)) return true;
    return hasLiveLease(this.toolsPrefix, { slot, release }).catch(() => true);
  }

  /** Deletes one release unless the shared rule keeps it. */
  private async removeReleaseIfFree(slot: string, release: string): Promise<void> {
    const live = await this.resolveCurrent(slot);
    const keep = await this.candidateReleaseDirs();
    if (await this.releaseIsKept(slot, release, live, keep)) return;
    await rm(path.join(this.toolsPrefix, "providers", slot, "releases", release), {
      recursive: true,
      force: true
    }).catch(() => undefined);
  }

  /** Runs the cleanup rule over one slot. Called when the last lease on a release is removed. */
  async sweepSlot(slot: string): Promise<void> {
    await this.sweepReleases(slot).catch(() => undefined);
  }

  /** Absolute release folders that any provider's `state.json` lists as a staged candidate. */
  private async candidateReleaseDirs(): Promise<Set<string>> {
    const keep = new Set<string>();
    for (const provider of Object.keys(this.deps.catalog)) {
      const state = await readToolsState(this.toolsPrefix, provider);
      for (const c of [...state.candidate, ...state.prior]) {
        keep.add(path.join(this.toolsPrefix, "providers", c.slot, "releases", c.release));
      }
    }
    return keep;
  }

  private async sweepReleases(provider: string): Promise<void> {
    const providerDir = path.join(this.toolsPrefix, "providers", provider);
    const releasesDir = path.join(providerDir, "releases");
    if (!(await pathExists(releasesDir))) return;
    const live = await this.resolveCurrent(provider);
    // A staged candidate is not referenced by `current` yet but must survive the sweep.
    const keep = await this.candidateReleaseDirs();
    const listed = await this.deps.io
      .run("ls", ["-A", releasesDir])
      .catch(() => ({ code: 1, stdout: "" }));
    if (listed.code !== 0) return;
    for (const name of splitLines(listed.stdout)) {
      const dir = path.join(releasesDir, name);
      if (await this.releaseIsKept(provider, name, live, keep)) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ─── #1081 H1: boot-time drift reconcile (deploy-drift fix) ─────────────────

  /**
   * #1081 H1: bumping a bundled CLI-tool's version only rebakes the recipe CATALOG into
   * the image — the binary itself lives in the named `jarv1s-cli-tools` volume, which
   * SURVIVES `docker compose pull && up -d` untouched. Before this fix, neither boot nor
   * engine-launch re-verified the live binary against the fresh recipe, so an instance
   * silently kept running a stale binary until an admin manually POSTed
   * `/api/onboarding/provider-install` (#1079's root cause).
   *
   * Reconciles every ALREADY-installed provider (a `bin/<binary>` symlink already resolves
   * executable — the same is-installed probe `tryIdempotentNoop` uses) against the CURRENT
   * catalog via the normal `installProvider` path: version+hash match ⇒ cheap no-op
   * (`tryIdempotentNoop`); drifted ⇒ a real reinstall. A provider with NO existing release
   * is left completely untouched — this is drift reconcile, not a fresh install; §A.2.3
   * (the admin-gated route) stays the SOLE trigger for a never-installed provider.
   *
   * Called from `CliChatEngineHost.startupSweep()` AFTER the `.staging`/orphan-release GC
   * above and BEFORE the server accepts its first request, so a drifted binary can never
   * serve a live session. Per-provider errors are swallowed (best-effort) so one
   * provider's reconcile fault never blocks another's, nor crashes boot.
   */
  async reconcileInstalledProviders(): Promise<void> {
    for (const provider of Object.keys(this.deps.catalog) as RpcProviderKind[]) {
      let recipe: InstallRecipe;
      try {
        recipe = this.resolveRecipe(provider);
      } catch {
        continue; // blocked / not in catalog — never a reconcile target.
      }
      if (!(await isExecutable(this.binPath(recipe.binary)))) continue; // never installed — leave to explicit admin action.
      await this.installProvider(provider).catch(() => undefined);
    }
  }

  // ─── paths + symlinks ───────────────────────────────────────────────────────

  /** The stable PATH bin: `/data/cli-tools/bin/<binary>`. */
  private binPath(binary: string): string {
    return path.join(this.toolsPrefix, "bin", binary);
  }

  /** Create the stable `bin/<binary>` symlink ONCE (idempotent on later installs). */
  private async ensureBinSymlink(provider: string, binary: string): Promise<void> {
    const binDir = path.join(this.toolsPrefix, "bin");
    await mkdir(binDir, { recursive: true });
    const linkPath = path.join(binDir, binary);
    const target = path.join(
      "..",
      "providers",
      provider,
      "current",
      "node_modules",
      ".bin",
      binary
    );
    await this.ensureSymlink(linkPath, target);
  }

  private async ensureArtifactBinSymlink(provider: RpcProviderKind, binary: string): Promise<void> {
    const binDir = path.join(this.toolsPrefix, "bin");
    await mkdir(binDir, { recursive: true });
    const linkPath = path.join(binDir, binary);
    const target = path.join("..", "providers", provider, binary);
    await this.ensureSymlink(linkPath, target);
  }

  /** Idempotently (re)point a symlink via temp-symlink-rename (atomic, same-dir). */
  private async ensureSymlink(linkPath: string, target: string): Promise<void> {
    const existing = await readlink(linkPath).catch(() => undefined);
    if (existing === target) return; // already correct — created ONCE
    const tmp = `${linkPath}.tmp-${randToken()}`;
    await symlink(target, tmp);
    await rename(tmp, linkPath);
  }

  /**
   * #2689: the version each supported npm recipe's live release reports in its package metadata,
   * or `null` when the provider has no live release, plus the image's OpenCode version.
   * Read-only; never probes a binary.
   */
  async toolVersions(): Promise<RpcListCliToolVersionsResult> {
    const versions: Record<RpcProviderKind, string | null> = {
      anthropic: null,
      "openai-compatible": null,
      google: null
    };
    for (const provider of Object.keys(versions) as RpcProviderKind[]) {
      const recipe = this.deps.catalog[provider]?.recipe;
      if (recipe?.kind !== "npm") continue;
      const release = await this.resolveCurrent(provider);
      if (!release) continue;
      versions[provider] = (await this.readInstalledVersion(release, recipe.pkg)) ?? null;
    }
    return { providers: versions, opencode: await readOpenCodeVersion() };
  }

  /** #2689 slice 4: highest accepted manifest sequence and the staged candidates, versions only. */
  async toolsState(): Promise<RpcGetCliToolsStateResult> {
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
      const state = await readToolsState(this.toolsPrefix, provider);
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

  /** Resolve the absolute dir `providers/<provider>/current` points at, or undefined. */
  private async resolveCurrent(provider: string): Promise<string | undefined> {
    const providerDir = path.join(this.toolsPrefix, "providers", provider);
    const link = await readlink(path.join(providerDir, "current")).catch(() => undefined);
    return link ? path.resolve(providerDir, link) : undefined;
  }

  // ─── staging + repo-path + timeout helpers ──────────────────────────────────

  /** §A.3.2 mk an ephemeral staging scratch UNDER the tools volume (same-fs as promote). */
  private async mkStaging(provider: string): Promise<string> {
    const stagingRoot = path.join(this.toolsPrefix, ".staging");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    return mkdtemp(path.join(stagingRoot, `${provider}-`));
  }

  /** Resolve a repo-relative recipe path (e.g. the committed lockfile) against the repo root. */
  private resolveRepoPath(repoRel: string): string {
    // This module is packages/cli-runner/src/install-service.ts ⇒ repo root is 3 up.
    return path.resolve(REPO_ROOT, repoRel);
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error("install timed out")), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ─── module-scope helpers ──────────────────────────────────────────────────

// Layout-robust repo root (shared with catalog.ts's findRepoRoot): walk up to the
// nearest pnpm-workspace.yaml. A fixed MODULE_DIR/../../.. offset breaks when this
// module is bundled into the api's dist (import.meta.url collapses to /app/dist → the
// offset lands on "/", so the committed lockfile read ENOENTs). #342 install blocker.
const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function createWriteStreamSafe(dest: string): ReturnType<typeof createWriteStream> {
  return createWriteStream(dest, { mode: 0o600 });
}

/** A short random token for staging dirs / release dirs / temp symlinks. */
function randToken(): string {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
}

/** SHA512 (lowercase hex) of a file's exact bytes. */
async function sha512OfFile(file: string): Promise<string> {
  const h = createHash("sha512");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

/**
 * SHA512 of the binary the path resolves TO (dereferencing a `.bin` symlink / the
 * `current` symlink chain). Node stat/readStream already follow symlinks, so this hashes
 * the real target bytes — the §A.3.4 promote-target hash.
 */
async function sha512OfResolved(file: string): Promise<string> {
  return sha512OfFile(file);
}

function hashEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await stat(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function isPublishedNpmRelease(release: string): Promise<boolean> {
  try {
    const st = await lstat(release);
    return st.isDirectory() && (st.mode & 0o777) === 0o755;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Redact an npm stderr blob (it can echo a registry URL with credentials). */
function redactNpm(s: string): string {
  return s.replace(/\/\/[^@\s/]+:[^@\s/]+@/g, "//<redacted>@").slice(0, 1500);
}

/** Convert any caught error to a short, non-secret message. */
function redactInstallMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactNpm(raw);
}
