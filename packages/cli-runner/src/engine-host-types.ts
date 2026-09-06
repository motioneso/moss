/**
 * Types and small constants shared by the cli-runner engine host. Split out of
 * engine-host.ts to keep that file under the repository file-size limit; the public
 * names are re-exported there so importers are unaffected.
 */

import type { Multiplexer, ProviderKind, TmuxIo } from "@moss/ai";
import type { AdmitCapablePool, ReapReason, RpcLaunchResult, SweepIdlePool } from "@moss/chat/live";

import type { InstallService } from "./install-service.js";
import type { LoginService } from "./login-service.js";

export interface EngineHostDeps {
  readonly io: TmuxIo;
  /** Shared multiplexer backend injected into every engine (bundled tmux, §7.1). */
  readonly mux?: Multiplexer;
  /** Base for `<sessionKey>` neutral dirs (`JARVIS_CLI_NEUTRAL_BASE`, §4.1.1a). */
  readonly neutralBase: string;
  /** HOME base for transcript resolution (`JARVIS_CLI_HOME_BASE`, §7.1). */
  readonly homeBase?: string;
  /** §4.1.0a single-active-user gate ON (default) / OFF (`JARVIS_CLI_RUNNER_SINGLE_USER`). */
  readonly singleUser: boolean;
  /**
   * #347 per-user UID isolation (`JARVIS_CLI_PER_USER_UID`). ON ⇒ every session's CLI
   * subprocess is setuid'd to a per-user allocated UID (100000+slot); this REQUIRES the
   * cli-runner container to run as root (the fork point needs CAP_SETUID). OFF (default) ⇒
   * the CLI runs as the cli-runner's OWN process UID (the host operator uid that owns the
   * auth/neutral volumes) — the proven pre-#347 single-identity topology. OFF is the
   * supported default until the per-user-UID file-permission model is completed + tested;
   * turning it ON without a root container fails every launch (setuid EPERM). See the
   * parallel proper-fix track. Optional: absent ⇒ OFF (the safe default), so callers that
   * never opt in (every current caller) get the proven single-identity topology for free.
   */
  readonly perUserUid?: boolean;
  /** Presence-only PATH probe for `probeProvider` (§4.8). */
  readonly cliPresent: (provider: ProviderKind) => Promise<boolean>;
  /** Optional multiplexer-usable check surfaced by `probeProvider` (§4.8 / §9.1). */
  readonly multiplexerUsable?: () => Promise<boolean>;
  /**
   * Out-of-lock mux-create bound (ms). A wedged tmux MUST NOT strand a reservation
   * (§4.1.0a): the launch fails with `unavailable` and the `finally` releases the key.
   * Defaults to a generous boot budget.
   */
  readonly launchTimeoutMs?: number;
  /** Failure-only total bound for queued + active verified submit. */
  readonly verifiedSubmitTimeoutMs?: number;
  /**
   * The §A.3 on-demand install service. The host's `installProvider` (§A.2.4) delegates
   * to it; it carries its OWN per-provider lock (§A.3.1), distinct from the §4.1.0a
   * admission mutex (the install lane is volume-disjoint from admission, §A.5.1). Absent
   * ⇒ `installProvider` reports the verb is unavailable on this build.
   */
  readonly installService?: InstallService;
  /**
   * The §L.3 login service (Phase 3). The host's login verbs (§L.2) delegate to it, and the
   * §L.6.1 UNIFIED admission gate consults its `isLoginActive()` from BOTH the launch gate and
   * the beginLogin gate (login is auth-volume-exclusive with chat — UNLIKE install, which is
   * volume-disjoint and lock-only). Absent ⇒ the login verbs report unavailable on this build.
   */
  readonly loginService?: LoginService;
  /**
   * #2208 `listProviderModels`: the vendor HTTP client the model-list adapters call. Absent ⇒
   * `globalThis.fetch`. Injected by tests so no unit test ever reaches a vendor.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * #1554 Decision 3 — the RPC topology's warm persistent-runtime pool + a live reader of
   * `chat.persistent_idle_reap_minutes`, consulted ONLY by {@link CliChatEngineHost.startIdleReapTimer}
   * (`sweepIdle`). Absent either ⇒ that timer is a no-op. Typed structurally
   * ({@link SweepIdlePool}, only `sweepIdle` used) so tests can pass a fake without constructing a
   * real pool — kept separate from {@link persistentRuntimePool} below (admission) so the existing
   * `sweepIdle`-only fakes in `tests/unit/cli-runner-idle-reap-timer.test.ts` don't also need an
   * `admit` method.
   */
  readonly persistentPool?: SweepIdlePool;
  /** Live read of `chat.persistent_idle_reap_minutes`, re-read fresh on every timer tick. */
  readonly readIdleReapMinutes?: () => Promise<number>;
  /**
   * #1554 task #5 — the RPC topology's warm-pool ADMISSION seam (`admit`), consulted by
   * `launchOnce` when building the engine (`createChatEngine`'s `persistentPool` opt). In
   * production this is the SAME `PersistentRuntimePool` instance as {@link persistentPool} above
   * (one pool serves both sweeping and admission); split into two deps only for the narrower
   * structural typing each call site needs. Presence of this dep is what lifts the
   * `persistentRuntimeEnabled: false` pin in `launchOnce` — absent ⇒ unchanged pre-task-5
   * behavior (always the bounded-fallback/tmux fork, #1350 two-composition-roots guard).
   */
  readonly persistentRuntimePool?: AdmitCapablePool;
  /**
   * #1554 — the MUTABLE live view of the three persistent-runtime settings, shared by reference
   * with `main.ts`'s composition root (the pool's `cap` getter and `readIdleReapMinutes` read the
   * same object). {@link CliChatEngineHost.applyPersistentRuntimeParams} refreshes it from every
   * launch's {@link RpcLaunchParams}, which is the plan's live-reload channel for this topology.
   * Absent ⇒ pre-#1554 behavior (pool presence alone gates persistent selection).
   */
  readonly persistentLiveConfig?: PersistentRuntimeLiveConfig;
}

/**
 * #1554 — the cli-runner's current view of `chat.persistent_runtime.enabled`,
 * `chat.persistent_pool_cap` and `chat.persistent_idle_reap_minutes`. Seeded from boot env as a
 * bootstrap default (the very first launch may arrive before the api reads settings), then kept
 * current by each launch's params. Mutable and shared by reference — never copied, or the pool and
 * the idle-reap timer would drift from the host.
 */
export interface PersistentRuntimeLiveConfig {
  enabled: boolean;
  poolCap: number;
  idleReapMinutes: number;
}

/** A cap or idle window of 0 denies every admission / reaps every warm child on the next tick, so
 *  a non-positive or non-finite value from the wire keeps the last known good value instead. */
export function positiveIntOr(value: unknown, lastKnown: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : lastKnown;
}

export const DEFAULT_LAUNCH_TIMEOUT_MS = 70_000;
export const VERIFIED_SUBMIT_DEADLINE_MS = 35_000;

export interface SubmitAttempt {
  digest: string | null;
  readonly controller: AbortController;
  promise?: Promise<void>;
}

export interface ReplayLaunchAttempt {
  readonly digest: string;
  readonly promise: Promise<RpcLaunchResult>;
}

// #1554 Decision 2: fired when the (process-wide) persistent runtime pool reaps a session, so
// every connected RPC client can be told via a `sessionReaped` push. Registered per-connection
// by `connection.ts`'s `serveConnection`, not per-terminal like `TerminalHost`'s `pushSink` —
// the pool's `onReap` fires host-side, not connection-side, and this host is the one
// process-wide instance shared across all accepted connections.
export type SessionReapedListener = (sessionKey: string, reason: ReapReason) => void;
