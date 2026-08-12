/**
 * cli-runner entrypoint (§3/§7). Reads its env, builds the engine host (with the §7.2
 * sanitized-env TmuxIo so app secrets / the socket path / the RPC secret never reach a
 * CLI child), and starts the socket server (which runs the startup CLEAN-SLATE sweep
 * before accepting connections).
 *
 * The cli-runner SERVER process carries JARVIS_CLI_RUNNER_SOCKET +
 * JARVIS_CLI_RUNNER_RPC_SECRET + JARVIS_CLI_RUNNER_SINGLE_USER (it needs the first two
 * to bind + authenticate and the third to enforce the §4.1.0a gate); the §7.2 allowlist
 * governs the CLI SUBPROCESS env it builds, which drops all three.
 */

import { dirname } from "node:path";

import { cliAvailable, tmuxAvailable, type ProviderKind } from "@moss/ai";

import {
  ClaudePersistentRuntime,
  PersistentRuntimePool,
  probeProvider,
  type RpcProviderKind
} from "@moss/chat/live";

import { resolveMossEnv } from "@moss/db";

import { PROVIDER_CATALOG } from "./catalog.js";
import { CliChatEngineHost } from "./engine-host.js";
import { InstallService } from "./install-service.js";
import { LOGIN_ADAPTERS } from "./login-adapters.js";
import { readProviderCredentialEnv } from "./provider-token-store.js";
import { LoginService } from "./login-service.js";
import { createSanitizedTmuxIo } from "./runner-io.js";
import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { CliRunnerServer } from "./server.js";
import { TerminalHost } from "./terminal-host.js";

export interface CliRunnerConfig {
  readonly socketPath: string;
  readonly rpcSecret: string | undefined;
  readonly singleUser: boolean;
  /** #347 per-user UID isolation (`JARVIS_CLI_PER_USER_UID`); default OFF — see EngineHostDeps. */
  readonly perUserUid: boolean;
  readonly neutralBase: string;
  readonly homeBase: string;
  /** Tools-volume prefix the installer stages/promotes into (`NPM_CONFIG_PREFIX`, §7.1). */
  readonly toolsPrefix: string;
  /**
   * #1554 task #5 — `chat.persistent_runtime.enabled`'s RPC-topology equivalent
   * (`MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED`). Unlike the in-process root
   * (`chat-multiplexer.ts`), cli-runner has no DB/live-config access, so this is a
   * boot-time snapshot, not a live-reloadable setting — a deliberate, documented deviation
   * from Decision 4's live-reload semantics for this one topology. Default OFF, matching
   * the pre-task-5 pinned-false behavior until an operator opts in.
   */
  readonly persistentRuntimeEnabled: boolean;
  /** `chat.persistent_pool_cap`'s boot-time snapshot (`MOSS_CHAT_PERSISTENT_POOL_CAP`); same
   *  fail-closed default (4) as the registry entry (`@moss/settings`), duplicated here rather
   *  than imported since cli-runner does not depend on `@moss/settings`. */
  readonly persistentPoolCap: number;
  /** `chat.persistent_idle_reap_minutes`'s boot-time snapshot
   *  (`MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES`); re-read on every timer tick from this SAME
   *  boot-time value (no live reload here — see {@link persistentRuntimeEnabled}'s doc). */
  readonly persistentIdleReapMinutes: number;
}

const DEFAULT_SOCKET = "/run/jarv1s/cli-runner.sock";
const DEFAULT_NEUTRAL_BASE = "/data/cli-auth/chat";
const DEFAULT_HOME = "/data/cli-auth";
const DEFAULT_TOOLS_PREFIX = "/data/cli-tools";
// #1554 task #5 — mirror the `@moss/settings` registry defaults (`chat.persistent_pool_cap` /
// `chat.persistent_idle_reap_minutes`) without taking a dependency on that package.
const DEFAULT_PERSISTENT_POOL_CAP = 4;
const DEFAULT_PERSISTENT_IDLE_REAP_MINUTES = 30;

/** Parse a positive-integer env var, falling back (fail-closed, never 0) on absence/garbage. */
function readPositiveIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Read the cli-runner config from the (server) env, applying §7 defaults. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): CliRunnerConfig {
  const homeBase =
    resolveMossEnv(env, "JARVIS_CLI_HOME_BASE") ??
    resolveMossEnv(env, "JARVIS_CLI_HOME") ??
    DEFAULT_HOME;
  return {
    // JARVIS_CLI_RUNNER_SOCKET/_RPC_SECRET/_SINGLE_USER/_PER_USER_UID/_TOOLS_PREFIX are
    // carve-outs (#1443) — see docs/superpowers/specs/2026-08-06-moss-rename-tier-c-carveout.md.
    socketPath: env.JARVIS_CLI_RUNNER_SOCKET ?? DEFAULT_SOCKET,
    rpcSecret: env.JARVIS_CLI_RUNNER_RPC_SECRET,
    // #347: default OFF now that per-user UID isolation is in place. Set "1" to
    // re-enable the single-active-user restriction as an operator escape hatch.
    singleUser: env.JARVIS_CLI_RUNNER_SINGLE_USER === "1",
    // #347: default OFF — the CLI runs as the cli-runner's own (host operator) UID, the proven
    // pre-#347 topology. Set "1" ONLY with a root container + the completed file-permission model
    // (parallel proper-fix track); ON without root fails every launch (setuid EPERM).
    perUserUid: env.JARVIS_CLI_PER_USER_UID === "1",
    neutralBase: resolveMossEnv(env, "JARVIS_CLI_NEUTRAL_BASE") ?? DEFAULT_NEUTRAL_BASE,
    homeBase,
    toolsPrefix: env.JARVIS_CLI_TOOLS_PREFIX ?? env.NPM_CONFIG_PREFIX ?? DEFAULT_TOOLS_PREFIX,
    // #1554 task #5 — see CliRunnerConfig's doc comments: boot-time snapshots, not live config.
    persistentRuntimeEnabled: env.MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED === "1",
    persistentPoolCap: readPositiveIntEnv(
      env.MOSS_CHAT_PERSISTENT_POOL_CAP,
      DEFAULT_PERSISTENT_POOL_CAP
    ),
    persistentIdleReapMinutes: readPositiveIntEnv(
      env.MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES,
      DEFAULT_PERSISTENT_IDLE_REAP_MINUTES
    )
  };
}

/**
 * Build the child environment for the CLI sidecar. The auth volume is the CLI's HOME, not merely
 * an auxiliary path: Claude and Codex resolve their onboarding, trust, credentials, and transcript
 * state from HOME. The runner process may itself inherit the host HOME, so override it before the
 * allowlist is applied. Without this, first-run seeding writes to `homeBase` while the tmux server
 * and provider CLI read the host's unrelated `~/.claude.json`.
 */
export function buildCliRunnerChildEnv(
  config: Pick<CliRunnerConfig, "homeBase">,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return buildSanitizedCliEnv({
    ...source,
    HOME: config.homeBase,
    JARVIS_CLI_HOME: config.homeBase,
    JARVIS_CLI_HOME_BASE: config.homeBase
  });
}

/**
 * §A.3.7 (R6, CRITICAL): source every catalog `kind:"env"` `selfUpdateDisable` pair
 * into the cli-runner `process.env` BEFORE the tmux fork. `buildSanitizedCliEnv` is a
 * passthrough FILTER, not a setter — allowlisting the key alone is a NO-OP: the value
 * never appears in `process.env`, so the §7.2 passthrough never delivers it to the
 * forked tmux server / launched CLI. Setting it on the cli-runner's OWN env here (the
 * catalog is the single source of truth; no compose hardcoding, no secret) is what makes
 * the launched CLI actually receive `DISABLE_AUTOUPDATER=1`. kind:"config" recipes need
 * NO env sourcing (they are a file the installer writes, §A.3.7). Mutates `target`
 * (default `process.env`) and returns the keys it set (for the boot log / the test).
 */
export function sourceSelfUpdateDisableEnv(
  target: NodeJS.ProcessEnv = process.env,
  catalog = PROVIDER_CATALOG
): string[] {
  const set: string[] = [];
  for (const entry of Object.values(catalog)) {
    if (entry.status !== "supported" || !entry.recipe) continue;
    const sud = entry.recipe.selfUpdateDisable;
    if (sud.kind === "env") {
      target[sud.key] = sud.value;
      set.push(sud.key);
    }
  }
  return set;
}

/** Construct the engine host + server from config (no I/O until `server.start()`). */
export function createCliRunner(
  config: CliRunnerConfig,
  log?: (msg: string) => void
): CliRunnerServer {
  // §A.3.7 R6: BEFORE createSanitizedTmuxIo() reads process.env, source the catalog's
  // kind:"env" self-update-disable pairs onto process.env so the §7.2 passthrough
  // actually carries them to the forked tmux server + every launched CLI.
  sourceSelfUpdateDisableEnv(process.env);

  // The §7.2 sanitized TmuxIo: every tmux/CLI child gets the allowlist env only.
  // HOME must match the configured auth volume. The runner commonly inherits the operator's
  // host HOME, but provider first-run state is deliberately seeded under config.homeBase.
  const io = createSanitizedTmuxIo(buildCliRunnerChildEnv(config));

  // The §A.3 install service. It carries its OWN per-provider lock (distinct from the
  // §4.1.0a admission mutex) and runs npm/artifact installs under the sanitized installer
  // env (the §7.2 allowlist PLUS only registry/proxy vars — NO secrets, §A.3.3). It reuses
  // the same execFile-style `io`, passing its installer env per call.
  const installService = new InstallService({
    io,
    catalog: PROVIDER_CATALOG,
    toolsPrefix: config.toolsPrefix,
    homeBase: config.homeBase
  });

  // §L.3 login service (Phase 3). It drives the provider login flow in a captured
  // `jarv1s-login-*` tmux session (auth-volume HOME), surfaces ONLY the allowlisted URL/code
  // (§L.6.2), and detects completion via the SAME §4.8 probe. Its adapters are the validated
  // login allowlist (§L.1.3, consistency-checked against the install catalog). It participates
  // in the host's §L.6.1 unified exclusivity gate (login ⟂ chat).
  const loginService = new LoginService({
    io,
    adapters: LOGIN_ADAPTERS,
    homeBase: config.homeBase,
    // Completion signal: the §4.8 provider auth probe (no token, no replay) — same deps the
    // host's probeProvider uses, PLUS the #363 claude-scoped credential env so `auth status`
    // reports loggedIn once the captured token is persisted (settling the flow `ready`).
    probe: async (provider: RpcProviderKind) =>
      probeProvider(provider as ProviderKind, {
        io,
        cliPresent: (p: ProviderKind) => cliAvailable(p),
        multiplexerUsable: () => tmuxAvailable(),
        credentialEnv: await readProviderCredentialEnv(config.homeBase, provider)
      })
  });

  // #1554 task #5 — the RPC topology's composition root for the warm pool. `PersistentRuntimePool`
  // needs `onReap` wired to `host.notifySessionReaped`, but `host` needs the pool (as a
  // constructor dep) to exist first — a forward-reference box breaks the cycle: `onReap` closes
  // over `hostRef`, which is assigned once `host` is constructed below, before `server.start()`
  // (and therefore before any session can be admitted/reaped) ever runs.
  const hostRef: { current: CliChatEngineHost | undefined } = { current: undefined };
  const persistentPool = config.persistentRuntimeEnabled
    ? new PersistentRuntimePool({
        cap: config.persistentPoolCap,
        // Mirrors the default (non-perUserUid) `sessionIo` in `engine-host.ts`'s `launchOnce`:
        // the SAME shared sanitized `io`, not a fresh one per session. `perUserUid`'s
        // per-session sanitized io is a known, accepted gap for pool-admitted runtimes (that
        // isolation mode is default OFF; revisit if it's ever turned on alongside the pool).
        createRuntime: () => new ClaudePersistentRuntime({ io }),
        onReap: (sessionKey, reason) => hostRef.current?.notifySessionReaped(sessionKey, reason),
        clock: { now: () => Date.now() }
      })
    : undefined;

  const host = new CliChatEngineHost({
    io,
    neutralBase: config.neutralBase,
    homeBase: config.homeBase,
    singleUser: config.singleUser,
    perUserUid: config.perUserUid,
    installService,
    loginService,
    // Presence-only PATH probe INSIDE cli-runner (the tools volume is on PATH, §7.1).
    cliPresent: (provider: ProviderKind) => cliAvailable(provider),
    multiplexerUsable: () => tmuxAvailable(),
    // #1554 task #5 — same concrete pool instance for both structural roles (sweep + admit);
    // see `EngineHostDeps`'s doc comments for why they're two separate fields.
    persistentPool,
    persistentRuntimePool: persistentPool,
    readIdleReapMinutes: persistentPool ? async () => config.persistentIdleReapMinutes : undefined
  });
  hostRef.current = host;

  // #1059 — one TerminalHost per process (NOT per connection): the owner-terminal security
  // model is "at most one live PTY for the whole cli-runner", so it lives at server-construction
  // scope and is threaded into every accepted connection (see ConnectionDeps in connection.ts).
  // toolsBinDir mirrors the installer's own `${toolsPrefix}/bin` convention (install-service.ts).
  const terminalHost = new TerminalHost({
    homeBase: config.homeBase,
    toolsBinDir: `${config.toolsPrefix}/bin`
  });

  return new CliRunnerServer({
    host,
    socketPath: config.socketPath,
    socketDir: dirname(config.socketPath),
    secret: config.rpcSecret,
    terminalHost,
    log
  });
}

/** Boot the cli-runner: read env, build, start. Logs and exits non-zero on a bind failure. */
export async function main(): Promise<void> {
  const config = readConfig();
  if (!config.rpcSecret) {
    // Without the secret EVERY hello closes (§3.6) — refuse to boot rather than run a
    // server that can authenticate nobody.
    console.error("[cli-runner] JARVIS_CLI_RUNNER_RPC_SECRET is unset — refusing to start");
    process.exitCode = 1;
    return;
  }
  const server = createCliRunner(config, (msg) => {
    console.log(msg);
  });
  await server.start();
}

// NOTE (#342 install/login blocker): this module has NO module-level side effect.
// The boot invocation lives in the dedicated, never-imported `main-entry.ts`.
//
// Why: an `if (isEntrypoint) main()` guard here used `import.meta.url ===
// \`file://${process.argv[1]}\``. esbuild bundles this module into the api's
// `dist/server.js` (the api imports the cli-runner barrel for PROVIDER_CATALOG /
// LOGIN_ADAPTERS), where `import.meta.url` COLLAPSES to the bundle URL
// (`file:///app/dist/server.js`) — which EQUALS `file://${process.argv[1]}` in the
// api process. So the guard mis-fired and the api booted its OWN CliRunnerServer,
// binding the same socket as the cli-runner sidecar (CLI ops then ran in the
// bundled api: no tmux session, ephemeral tools volume). Keeping the invocation in
// a separate entry file that nothing ever imports makes the collapse irrelevant.
