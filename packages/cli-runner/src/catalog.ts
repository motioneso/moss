/**
 * §A.1 RECIPE CATALOG — the server-side supply-chain ALLOWLIST.
 *
 * A typed, server-side, compile-time-constant allowlist mapping each provider to
 * exactly one pinned install recipe. THE CATALOG IS THE ALLOWLIST: any provider not
 * present (or `blocked`) is rejected with `RpcErr bad_request` (§A.2.3). There is NO
 * `latest`, NO `^`/`~`/range version, NO mutable tag, NO unpinned `curl | bash`.
 *
 * This module is SERVER-SIDE ONLY (cli-runner) — it touches `node:fs` to validate the
 * committed lockfiles at load, so it must NEVER be imported into the browser bundle.
 * The shared TYPES live in `@moss/chat/live` (packages/chat/src/live/install-contract.ts).
 *
 * Pinned 2026-06-20 (Catalog stage, #342 Phase 2). The version literals, the per-arch
 * native-binary package names, the committed lockfiles, and the concrete
 * self-update-disable mechanisms below were resolved against the ACTUAL published
 * packages and their native binaries — not from memory (see the build-stage notes per
 * recipe). Re-pinning is a deliberate maintainer step: bump the version, regenerate the
 * committed `npm-shrinkwrap.json` (`npm install <pkg>@<version> --package-lock-only
 * --ignore-scripts`), re-confirm the self-update mechanism the new version honors.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  CatalogEntry,
  InstallRecipe,
  NpmInstallRecipe,
  ProviderCatalog,
  RpcProviderKind
} from "@moss/chat/live";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the repo root that the committed recipe lockfiles (and any other repo-relative data)
 * are anchored to. CANNOT use a fixed `MODULE_DIR/../../..` offset: this module is consumed BOTH
 * by the cli-runner (run via `tsx` from `packages/cli-runner/src`, where the offset would be the
 * repo root) AND bundled into the api's `dist/server.js` (where `import.meta.url` collapses to the
 * bundle dir, `/app/dist`, so the offset lands on `/` and the lockfile reads "missing" — which
 * demoted claude/codex to `blocked` at catalog load INSIDE the api, 400-ing the install route
 * before the RPC ever reached the cli-runner). `scripts/build-app.ts` documents this same
 * bundling-collapses-import.meta.url hazard for SQL dirs; the lockfile read has it too.
 *
 * So walk UP from the module dir to the nearest `pnpm-workspace.yaml` (the repo-root marker) — this
 * is correct from `src` (tsx), from a `dist` bundle (the prod image is `FROM build`, so `/app` has
 * the marker), and from a test run. Fall back to the container WORKDIR `/app`, then `process.cwd()`.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (existsSync(path.join("/app", "pnpm-workspace.yaml"))) return "/app";
  return process.cwd();
}

/** Repo root the recipe lockfiles resolve against (layout-robust — see {@link findRepoRoot}). */
const REPO_ROOT = findRepoRoot(MODULE_DIR);

/** Marks any catalog literal a maintainer forgot to pin (forces `blocked`, §A.1.4). */
const PLACEHOLDER_RE = /<PINNED_[A-Z0-9_]*>|<[A-Z0-9_]+_(URL|SHA512|PATH|PKG|VERSION)>/;

// ---------------------------------------------------------------------------
// §A.1.2 — The FROZEN catalog values (claude + codex + gemini all supported)
// ---------------------------------------------------------------------------

/**
 * The raw, pre-validation catalog literals. `loadCatalog()` (below) applies §A.1.4 pin
 * validation and demotes any malformed `supported` recipe to `blocked`. The EXPORTED
 * `PROVIDER_CATALOG` is the validated result.
 */
const RAW_CATALOG: Record<RpcProviderKind, CatalogEntry> = {
  anthropic: {
    provider: "anthropic",
    status: "supported",
    recipe: {
      kind: "npm",
      pkg: "@anthropic-ai/claude-code",
      // PINNED 2026-06-20: current stable published EXACT version (`npm view`).
      version: "2.1.183",
      // COMMITTED full-tree-sha512 lockfile; install runs `npm ci --ignore-scripts`.
      lockfile: "packages/cli-runner/recipes/anthropic/npm-shrinkwrap.json",
      binary: "claude",
      // claude 2.1.183 ships per-arch native binaries via optionalDependencies (the
      // wrapper's postinstall normally copies them; with --ignore-scripts the install
      // service places the host-arch binary EXPLICITLY, §A.1.3).
      archOptionalDeps: true,
      archBinaryPackage: {
        "linux-x64": "@anthropic-ai/claude-code-linux-x64",
        "linux-arm64": "@anthropic-ai/claude-code-linux-arm64"
      },
      // EXPLICIT native-binary placement (§A.1.3): claude's main-package bin wrapper
      // (`bin/claude.exe`) is a STUB that prints "claude native binary not installed" and
      // exits 1 until the package's `install.cjs` postinstall copies the per-arch native
      // binary over it. With `--ignore-scripts` that postinstall is skipped, so the install
      // service DETERMINISTICALLY replaces the wrapper with the per-arch package's native
      // `claude` file (relative symlink + chmod) before verify — replicating ONLY the file
      // placement the script would do, never running it. (codex OMITS this — its `bin/codex.js`
      // wrapper self-resolves the native binary at runtime.)
      archBinaryPlacement: {
        archBinaryFile: "claude",
        wrapperRelPath: "bin/claude.exe"
      },
      // RESOLVED self-update-disable: the pinned native binary's update-status resolver
      // (`She()`) checks `DISABLE_AUTOUPDATER` FIRST and unconditionally, short-circuiting
      // BEFORE the config `autoUpdates`/native-install gate (which is bypassed for native
      // installs). The config `~/.claude/settings.json autoUpdates:false` is NOT reliable
      // for the native install (gated on installMethod !== "native"); the env var IS. So
      // claude pins kind:"env" — the key is added to the §7.2 ALLOWED_KEYS and MUST be
      // boot-sourced into the cli-runner process.env in main.ts (§A.3.7, R6).
      selfUpdateDisable: { kind: "env", key: "DISABLE_AUTOUPDATER", value: "1" }
    }
  },
  "openai-compatible": {
    provider: "openai-compatible",
    status: "supported",
    recipe: {
      kind: "npm",
      pkg: "@openai/codex",
      // PINNED 2026-07-15: current stable published EXACT version (`npm view`); re-pinned #1079: gpt-5.6-luna needs codex >=0.144.0.
      version: "0.144.5",
      lockfile: "packages/cli-runner/recipes/openai-compatible/npm-shrinkwrap.json",
      binary: "codex",
      // codex ships per-arch native binaries via aliased optionalDependencies; the JS
      // wrapper (bin/codex.js) resolves the native package at runtime. The install
      // service confirms the host-arch package from the lockfile-pinned version (§A.1.3).
      archOptionalDeps: true,
      archBinaryPackage: {
        // Lockfile node_modules KEYS (the alias targets `@openai/codex@<v>-linux-<arch>`).
        "linux-x64": "@openai/codex-linux-x64",
        "linux-arm64": "@openai/codex-linux-arm64"
      },
      // RESOLVED self-update-disable (kind:"config" — preferred, sidesteps the R6 env
      // source): codex 0.144.5 is npm-managed (CODEX_MANAGED_BY_NPM) so it NEVER
      // self-replaces its binary in place (the pin + lockfile + npm ci fully control the
      // bytes); the only residual is a startup update CHECK/notice, disabled by the
      // honored top-level config.toml bool `check_for_update_on_startup`. HOME is
      // /data/cli-auth (CODEX_HOME default ~/.codex), so the installer writes
      // /data/cli-auth/.codex/config.toml.
      selfUpdateDisable: {
        kind: "config",
        path: ".codex/config.toml",
        content: "check_for_update_on_startup = false\n"
      }
    }
  },
  google: {
    provider: "google",
    status: "supported",
    recipe: {
      kind: "npm",
      pkg: "@google/gemini-cli",
      // PINNED 2026-08-27 (#2026): current stable published EXACT version, resolved against the
      // LIVE registry (`npm view @google/gemini-cli version`) and rehearsed end-to-end outside the
      // repo — `npm ci --ignore-scripts` against the committed lockfile exits 0, produces
      // `node_modules/.bin/gemini`, and `gemini --version` prints 0.57.0.
      version: "0.57.0",
      // COMMITTED full-tree-sha512 lockfile (13 entries, every one carrying sha512).
      lockfile: "packages/cli-runner/recipes/google/npm-shrinkwrap.json",
      // The package's ONLY exposed command (`bin: { gemini: "bundle/gemini.js" }`). There is no
      // `agy` command in it — naming the binary `agy` here fails verify with "installed package
      // produced no executable". The API-side presence probe accepts both names (§ packages/ai
      // cli-availability aliases), so the historical `agy` naming keeps working.
      binary: "gemini",
      // DELIBERATELY no archOptionalDeps / archBinaryPackage / archBinaryPlacement: unlike claude
      // and codex, gemini ships ONE bundled JavaScript program (chunked, ~95 MB) rather than
      // per-arch native binaries, and its command runs straight out of `npm ci --ignore-scripts`.
      // Setting archOptionalDeps would make §A.1.4 demand per-arch packages that do not exist.
      // The lockfile does cover linux x64 AND arm64 (the terminal helper pulls both), so the pin
      // is not Intel-only.
      //
      // RESOLVED self-update-disable (kind:"config"): gemini 0.57.0 REALLY DOES replace itself —
      // its update handler spawns `npm install -g @google/gemini-cli@<newer>` detached, which
      // would silently swap the pinned bytes. Two settings gate that path, both under `general`
      // and both defaulting to TRUE, so both are set false here:
      //   * enableAutoUpdateNotification — checked FIRST in both the update check and the update
      //     handler; false short-circuits before any install can be considered.
      //   * enableAutoUpdate — false returns before the spawn even if a check somehow ran.
      // Older spellings (disableAutoUpdate / disableUpdateNag) survive only as deprecated aliases
      // that migrate onto these two names, so the new names are the correct ones to write.
      // HOME is /data/cli-auth and the tool reads <HOME>/.gemini/settings.json (GEMINI_CLI_HOME
      // would override that, but it is not in the §7.2 env allowlist and appears nowhere in this
      // repo), so the installer writes /data/cli-auth/.gemini/settings.json. This is a DIFFERENT
      // file from the per-session workspace settings chat writes at launch (`writeGeminiSettings`
      // in packages/chat/src/live/cli-launch-commands.ts) — that one sets no `general` keys, so it
      // cannot override these. Do not merge the two.
      selfUpdateDisable: {
        kind: "config",
        path: ".gemini/settings.json",
        content: `${JSON.stringify(
          { general: { enableAutoUpdate: false, enableAutoUpdateNotification: false } },
          null,
          2
        )}\n`
      }
    }
  }
};

// ---------------------------------------------------------------------------
// §A.1.4 — Pin validation (rejects a bad recipe at LOAD; demotes to `blocked`)
// ---------------------------------------------------------------------------

/** EXACT semver: no leading ^/~/>=, no latest/next/dist-tag, no `*`. */
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A lowercase-hex SHA512 (artifact recipes). */
const SHA512_HEX_RE = /^[0-9a-f]{128}$/;
/** A minimal parsed npm lockfile shape (only what §A.1.4 needs to assert integrity). */
interface ParsedLockfile {
  readonly packages?: Record<string, { integrity?: string; link?: boolean }>;
}

/** Reason a `supported` recipe was demoted to `blocked` at load (for the assertion log). */
export interface CatalogValidationIssue {
  readonly provider: RpcProviderKind;
  readonly reason: string;
}

function hasPlaceholder(...values: (string | undefined)[]): boolean {
  return values.some((v) => typeof v === "string" && PLACEHOLDER_RE.test(v));
}

/**
 * Assert the committed lockfile EXISTS, PARSES, and EVERY resolved package (the full
 * transitive tree, not just the top level) carries a `sha512` `integrity`. This is the
 * SAME bar agy is held to: no full-tree integrity ⇒ not installable. The content is not
 * re-verified byte-for-byte here (that is `npm ci`'s job at install) — presence +
 * structural integrity-coverage IS asserted, so a top-level-only pin can never ship.
 */
function validateLockfileIntegrity(lockfileRelPath: string): string | null {
  // The recipe `lockfile` is repo-relative (e.g. packages/cli-runner/recipes/...), resolved
  // against the layout-robust REPO_ROOT (works from src/tsx, the bundled api dist, and tests).
  const candidate = path.resolve(REPO_ROOT, lockfileRelPath);
  let raw: string;
  try {
    raw = readFileSync(candidate, "utf8");
  } catch {
    return `lockfile missing or unreadable at ${lockfileRelPath}`;
  }
  let parsed: ParsedLockfile;
  try {
    parsed = JSON.parse(raw) as ParsedLockfile;
  } catch {
    return `lockfile does not parse as JSON at ${lockfileRelPath}`;
  }
  const packages = parsed.packages;
  if (!packages || typeof packages !== "object") {
    return `lockfile has no \`packages\` map (lockfileVersion >= 2 required) at ${lockfileRelPath}`;
  }
  const entries = Object.entries(packages);
  if (entries.length === 0) {
    return `lockfile \`packages\` map is empty at ${lockfileRelPath}`;
  }
  for (const [key, meta] of entries) {
    // The root project entry ("") and pure symlink ("link") entries carry no tarball
    // integrity — every OTHER resolved package MUST have a sha512 integrity.
    if (key === "" || meta?.link === true) continue;
    const integrity = meta?.integrity;
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      return `lockfile package \`${key}\` lacks sha512 integrity at ${lockfileRelPath}`;
    }
  }
  return null; // full-tree sha512 coverage confirmed
}

function validateNpmRecipe(provider: RpcProviderKind, r: NpmInstallRecipe): string | null {
  if (!EXACT_SEMVER_RE.test(r.version)) {
    return `npm version "${r.version}" is not an exact semver`;
  }
  if (hasPlaceholder(r.version, r.lockfile, r.pkg, r.binary)) {
    return `npm recipe carries an unresolved <PINNED_*> placeholder`;
  }
  if (!r.lockfile || r.lockfile.trim() === "") {
    return `npm recipe has no committed lockfile`;
  }
  const lockIssue = validateLockfileIntegrity(r.lockfile);
  if (lockIssue) return lockIssue;
  if (r.archOptionalDeps) {
    const x64 = r.archBinaryPackage?.["linux-x64"];
    const arm64 = r.archBinaryPackage?.["linux-arm64"];
    if (!x64 || !arm64 || hasPlaceholder(x64, arm64)) {
      return `archOptionalDeps recipe is missing a per-arch archBinaryPackage entry`;
    }
  }
  return validateSelfUpdateDisable(provider, r);
}

function validateSelfUpdateDisable(_provider: RpcProviderKind, r: InstallRecipe): string | null {
  const sud = r.selfUpdateDisable;
  if (!sud) return `recipe has no selfUpdateDisable`;
  if (sud.kind === "env") {
    if (!sud.key || !sud.value || hasPlaceholder(sud.key, sud.value)) {
      return `selfUpdateDisable(env) has a missing/placeholder key or value`;
    }
  } else if (sud.kind === "config") {
    if (!sud.path || !sud.content || hasPlaceholder(sud.path, sud.content)) {
      return `selfUpdateDisable(config) has a missing/placeholder path or content`;
    }
  } else {
    return `selfUpdateDisable has an unknown kind`;
  }
  return null;
}

function validateRecipe(provider: RpcProviderKind, recipe: InstallRecipe): string | null {
  if (recipe.kind === "npm") return validateNpmRecipe(provider, recipe);
  // artifact
  if (hasPlaceholder(recipe.url, recipe.sha512, recipe.version, recipe.binary)) {
    return `artifact recipe carries an unresolved placeholder`;
  }
  if (!recipe.url.startsWith("https:")) return `artifact url is not https:`;
  if (recipe.url.includes("latest")) return `artifact url contains "latest"`;
  if (!recipe.url.includes(recipe.version)) {
    return `artifact url does not contain the version (not pinned)`;
  }
  if (!SHA512_HEX_RE.test(recipe.sha512)) {
    return `artifact sha512 is not 128 lowercase-hex chars`;
  }
  if (!recipe.version) return `artifact version is empty`;
  return validateSelfUpdateDisable(provider, recipe);
}

/**
 * Apply §A.1.4 to one raw entry. A `supported` entry whose recipe fails validation is
 * DEMOTED to `blocked` (treated exactly like agy — no installable recipe is exposed).
 */
function validateEntry(entry: CatalogEntry, issues: CatalogValidationIssue[]): CatalogEntry {
  if (entry.status === "blocked") {
    // A blocked entry MUST NOT carry a recipe (§A.1.4).
    if (entry.recipe) {
      issues.push({ provider: entry.provider, reason: "blocked entry carries a recipe" });
      return { ...entry, recipe: undefined };
    }
    return entry;
  }
  // status === "supported"
  if (!entry.recipe) {
    issues.push({ provider: entry.provider, reason: "supported entry has no recipe" });
    return {
      provider: entry.provider,
      status: "blocked",
      blockedReason: "recipe missing (demoted at load)",
      recipe: undefined
    };
  }
  const issue = validateRecipe(entry.provider, entry.recipe);
  if (issue) {
    issues.push({ provider: entry.provider, reason: issue });
    return {
      provider: entry.provider,
      status: "blocked",
      blockedReason: `recipe not installable: ${issue}`,
      recipe: undefined
    };
  }
  return entry;
}

/**
 * Validate the raw catalog (§A.1.4) and return the frozen, validated `ProviderCatalog`
 * plus the list of demotions. Call once at module load; a `blocked`-everything result
 * never reaches a real install because §A.2.3 rejects blocked providers.
 */
function loadCatalog(raw: Record<RpcProviderKind, CatalogEntry> = RAW_CATALOG): {
  catalog: ProviderCatalog;
  issues: CatalogValidationIssue[];
} {
  const issues: CatalogValidationIssue[] = [];
  const out: Record<RpcProviderKind, CatalogEntry> = {
    anthropic: validateEntry(raw.anthropic, issues),
    "openai-compatible": validateEntry(raw["openai-compatible"], issues),
    google: validateEntry(raw.google, issues)
  };
  return { catalog: Object.freeze(out) as ProviderCatalog, issues };
}

/** The validated, frozen catalog — THE single source of truth (§A.1.2). */
const loaded = loadCatalog();

/**
 * The validated allowlist. Consumed by the §A.2.4 connection dispatch (catalog-status
 * gate) and the §A.3 install service. Any provider `blocked` here (intrinsically or
 * demoted by §A.1.4) is rejected at install with `bad_request` (§A.2.3).
 */
export const PROVIDER_CATALOG: ProviderCatalog = loaded.catalog;

/** Demotions recorded by the load-time pin validation (§A.1.4) — for the boot log/test. */
export const CATALOG_VALIDATION_ISSUES: readonly CatalogValidationIssue[] = loaded.issues;
