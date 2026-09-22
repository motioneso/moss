/**
 * Moss rename Tier C (#1443): dual-read environment variable shim.
 *
 * The product was renamed Jarv1s -> Moss (see docs/superpowers/specs/2026-08-05-moss-rename-design.md).
 * Config knobs were historically named `JARVIS_*`; new deployments should set `MOSS_*` instead.
 * This module is the one seam that understands both names so the ~150 individual call sites
 * scattered across the monorepo don't each need their own fallback logic.
 *
 * `resolveMossEnv(env, "JARVIS_FOO")` prefers `env.MOSS_FOO`, falls back to `env.JARVIS_FOO` if
 * unset, and — the first time (and only the first time) a process actually relies on the old
 * name — emits a `console.warn` naming that specific variable. Once the host file is updated to
 * `MOSS_*`, the warning stops appearing and, one release later, the `JARVIS_*` fallback branch
 * can be deleted outright (see the design doc, Tier C).
 *
 * Carve-out: a name in `CARVE_OUT` is read by something this shim can't reach — Docker Compose
 * host-side `${JARVIS_X}` interpolation in `infra/docker-compose*.yml`, one of a handful of shell
 * scripts that read `$JARVIS_X` directly, never through Node, or a build-time config file
 * (`apps/web/vite.config.ts`, `tests/uat/playwright.uat.config.ts`) loaded by a plain `node`
 * config-load step that runs outside the application's module graph, before any app code runs —
 * `@moss/db`'s own barrel can't be pulled in there. For those names this function
 * is a plain passthrough: no `MOSS_` lookup, no warning, `env[jarvisName]` unchanged. Doing
 * anything else would silently break the name everywhere else it's read, since those other
 * readers never see `MOSS_X`. The full per-variable reasoning for every carved-out name lives in
 * `docs/superpowers/specs/2026-08-06-moss-rename-tier-c-carveout.md`; this set must stay in sync
 * with that document.
 */

export const CARVE_OUT: ReadonlySet<string> = new Set([
  "JARVIS_ALLOW_STALE",
  "JARVIS_API_PORT",
  "JARVIS_API_PROXY_TARGET",
  "JARVIS_BACKUP_DAILY_KEEP",
  "JARVIS_BACKUP_DIR",
  "JARVIS_BACKUP_OFFHOST_CMD",
  "JARVIS_BACKUP_PG_CONTAINER",
  "JARVIS_BACKUP_WEEKLY_KEEP",
  "JARVIS_CLI_PER_USER_UID",
  "JARVIS_CLI_RUNNER_RPC_SECRET",
  "JARVIS_CLI_RUNNER_SINGLE_USER",
  "JARVIS_CLI_RUNNER_SOCKET",
  "JARVIS_CLI_TOOLS_PREFIX",
  "JARVIS_DEV_EMAIL",
  "JARVIS_DEV_PASSWORD",
  "JARVIS_DOCKER_SUBNET",
  "JARVIS_EMBED_MODEL",
  "JARVIS_EMBED_PROVIDER",
  "JARVIS_ENV_FILE",
  "JARVIS_ENV_FILE_ABS",
  "JARVIS_GATE_DIR",
  "JARVIS_GATE_STALE_SECS",
  "JARVIS_HOST_GID",
  "JARVIS_HOST_UID",
  "JARVIS_IMAGE_TAG",
  "JARVIS_MCP_SERVER_URL",
  "JARVIS_NOTES_VAULT_HOST_PATH",
  "JARVIS_PG_CONTAINER",
  "JARVIS_PGDATABASE",
  "JARVIS_SMOKE_APP_CONTAINER",
  "JARVIS_SMOKE_BASE_URL",
  "JARVIS_SMOKE_DB_CONTAINER",
  "JARVIS_SMOKE_DB_NAME",
  "JARVIS_SMOKE_SURFACE",
  "JARVIS_SMOKE_TIMEOUT_MS",
  "JARVIS_SMOKE_USER_EMAIL",
  "JARVIS_TLS_HOST",
  "JARVIS_TLS_ISSUER",
  "JARVIS_UAT_BASE_URL",
  "JARVIS_UAT_REAL_CHAT_ENV_FILE",
  "JARVIS_UAT_SEED_CONFIRM",
  "JARVIS_UAT_SEED_EXCLUDE_CHUNKS",
  "JARVIS_UAT_SEED_LEVEL",
  "JARVIS_VAULT_DIR",
  "JARVIS_WEB_PORT"
]);

const JARVIS_PREFIX = "JARVIS_";
const MOSS_PREFIX = "MOSS_";

const warnedOnce = new Set<string>();

/**
 * Resolve a config value that may be set under either its new `MOSS_*` name or its legacy
 * `JARVIS_*` name. Always pass the legacy `JARVIS_*` name as `jarvisName` — this function derives
 * the `MOSS_*` counterpart itself, so no call site needs to know both spellings.
 *
 * Non-`JARVIS_*` names and carved-out names pass straight through to `env[jarvisName]`.
 */
export function resolveMossEnv(env: NodeJS.ProcessEnv, jarvisName: string): string | undefined {
  if (!jarvisName.startsWith(JARVIS_PREFIX) || CARVE_OUT.has(jarvisName)) {
    return env[jarvisName];
  }

  const mossName = MOSS_PREFIX + jarvisName.slice(JARVIS_PREFIX.length);
  const mossValue = env[mossName];
  if (mossValue !== undefined) {
    return mossValue;
  }

  const jarvisValue = env[jarvisName];
  if (jarvisValue !== undefined && !warnedOnce.has(jarvisName)) {
    warnedOnce.add(jarvisName);
    console.warn(
      `[moss-rename] ${jarvisName} is deprecated, use ${mossName} instead. ` +
        `${jarvisName} support will be removed in a future release.`
    );
  }
  return jarvisValue;
}

/** Test-only: clear the one-time-warning state between test cases. */
export function __resetMossEnvWarningsForTest(): void {
  warnedOnce.clear();
}

export function isCarvedOutMossEnvName(name: string): boolean {
  return CARVE_OUT.has(name);
}
