/**
 * CliChatEngineHost — the server-side engine registry + RPC method dispatch for the
 * cli-runner. It hosts a `Map<sessionKey, CliChatEngineImpl>`, serializes operations
 * per sessionKey (§4.0), and enforces the §4.1.0a SINGLE-ACTIVE-USER GATE.
 *
 * Liveness is measured on the MUX (`listLiveMuxSessions`, §4.6) UNION the server-side
 * in-flight-launch RESERVATION set UNION the engine registry — never the engine Map alone, never the api-side `launching` map (which is invisible here). Admission runs in ONE global async-critical-section
 * (a server-wide mutex, NOT the per-sessionKey queue). See `launch` for the full TOCTOU
 * argument.
 */

import { createHash } from "node:crypto";

import {
  CliChatUnavailableError,
  VerifiedSubmitError,
  createChatEngine,
  deriveNeutralDir,
  killMuxSessionByName,
  listLiveMuxSessions,
  probeProvider,
  purgePrivateTranscripts,
  purgePrivateTranscriptMarkers,
  removeNeutralDir,
  sanitizeSessionKey,
  type CliChatEngine,
  // #1350: type-only now — the host builds its engine through `createChatEngine`, never by
  // naming an implementation. Kept solely for the `hasVerifiedSubmit` capability narrow.
  type CliChatEngineImpl,
  type ProbeProviderResult,
  type RpcBeginLoginResult,
  type RpcCancelLoginResult,
  type RpcInstallProviderResult,
  type RpcLaunchParams,
  type RpcLaunchResult,
  type RpcKillParams,
  type RpcListProviderModelsResult,
  type RpcPollLoginResult,
  type RpcProbeProviderResult,
  type RpcProviderKind,
  type RpcReadNewResult,
  type RpcReadStructuredResult,
  type RpcCancelSubmitParams,
  type RpcSubmitParams,
  type RpcSubmitLoginTokenResult,
  type RpcSubmitStructuredResult,
  type ReapReason,
  type SweepIdlePool,
  type AdmitCapablePool,
  startIdleReapTimer as startPoolIdleReapTimer
} from "@moss/chat/live";
import type { Multiplexer, ProviderKind, TmuxIo } from "@moss/ai";

import { Mutex } from "./mutex.js";
import type { InstallService } from "./install-service.js";
import { LoginBadRequestError, type LoginService } from "./login-service.js";
import { createCodexVersionReader, listProviderModels } from "./model-list-adapters.js";
import { ensureProviderLaunchReady } from "./provider-first-run.js";
import { providerTokenPath, readProviderCredentialEnv } from "./provider-token-store.js";
import { allocateUidSlot, migrateNeutralDir } from "./uid-allocator.js";
import { createSanitizedTmuxIo } from "./runner-io.js";

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
function positiveIntOr(value: unknown, lastKnown: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : lastKnown;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 70_000;
export const VERIFIED_SUBMIT_DEADLINE_MS = 35_000;

interface SubmitAttempt {
  digest: string | null;
  readonly controller: AbortController;
  promise?: Promise<void>;
}

interface ReplayLaunchAttempt {
  readonly digest: string;
  readonly promise: Promise<RpcLaunchResult>;
}

// #1554 Decision 2: fired when the (process-wide) persistent runtime pool reaps a session, so
// every connected RPC client can be told via a `sessionReaped` push. Registered per-connection
// by `connection.ts`'s `serveConnection`, not per-terminal like `TerminalHost`'s `pushSink` —
// the pool's `onReap` fires host-side, not connection-side, and this host is the one
// process-wide instance shared across all accepted connections.
export type SessionReapedListener = (sessionKey: string, reason: ReapReason) => void;

export class CliChatEngineHost {
  // #1350: widened from CliChatEngineImpl — a `non_interactive` session is now backed by a
  // one-shot print engine, which implements CliChatEngine but has no multiplexer pane and so
  // no `verifiedSubmit`/`purgeTranscripts`. Both call sites feature-detect rather than assume.
  private readonly engines = new Map<string, CliChatEngine>();
  /** §4.0 per-sessionKey serialization queues (submit can't interleave a kill). */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** §4.1.0a server-side in-flight-launch reservations (NOT the api's launching map). */
  private readonly reservations = new Set<string>();
  /** §4.1.0a admission critical section (a SERVER-WIDE mutex, not the per-key queue). */
  private readonly admissionMutex = new Mutex();
  private readonly launchTimeoutMs: number;
  private readonly verifiedSubmitTimeoutMs: number;
  private readonly submitAttempts = new Map<string, Map<string, SubmitAttempt>>();
  /** #1525: FIFO of attemptIds created as cancel-before-submit tombstones (digest === null at
   *  creation) per session key. Bounds only synthetic tombstones — never touches real submitted
   *  attempts or active-attempt abortion. */
  private readonly tombstoneOrder = new Map<string, string[]>();
  private static readonly MAX_SYNTHETIC_TOMBSTONES = 128;
  private readonly replayLaunches = new Map<string, Map<string, ReplayLaunchAttempt>>();
  /** #1554 Decision 2: one listener per connected RPC connection; see `SessionReapedListener`. */
  private readonly reapListeners = new Set<SessionReapedListener>();
  /** #1554 Decision 3: the armed idle-reap timer's stop fn, or null when not (yet) started. */
  private idleReapStop: (() => void) | null = null;

  constructor(private readonly deps: EngineHostDeps) {
    this.launchTimeoutMs = deps.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    this.verifiedSubmitTimeoutMs = deps.verifiedSubmitTimeoutMs ?? VERIFIED_SUBMIT_DEADLINE_MS;
  }

  /** Registers a listener for session-reaped events; returns an unregister function. */
  addSessionReapedListener(listener: SessionReapedListener): () => void {
    this.reapListeners.add(listener);
    return () => this.reapListeners.delete(listener);
  }

  /** Called by the pool's `onReap` (wired in `main.ts`'s `createCliRunner`) — fans out to every
   *  connected RPC connection's `sessionReaped` push (`connection.ts`). */
  notifySessionReaped(sessionKey: string, reason: ReapReason): void {
    for (const listener of this.reapListeners) listener(sessionKey, reason);
  }

  /**
   * #1554 Decision 3: arm the persistent-pool idle-reap timer (this host is the RPC topology's
   * composition root per the plan). No-ops (returns a no-op stop fn) when `persistentPool`/
   * `readIdleReapMinutes` are not wired — true today; task #5 wires them and calls this from
   * `main.ts`. Double-start-safe: clears any prior timer first, mirroring `CliRunnerServer`'s
   * login-reaper guard (`server.ts`). `intervalMs` overrides the derived tick cadence (tests).
   */
  startIdleReapTimer(intervalMs?: number): () => void {
    this.idleReapStop?.();
    this.idleReapStop = null;
    const { persistentPool, readIdleReapMinutes } = this.deps;
    if (!persistentPool || !readIdleReapMinutes) {
      return () => {};
    }
    const stop = startPoolIdleReapTimer({
      pool: persistentPool,
      readIdleReapMinutes,
      intervalMs
    });
    this.idleReapStop = stop;
    return () => {
      stop();
      if (this.idleReapStop === stop) this.idleReapStop = null;
    };
  }

  /** Stops the idle-reap timer if armed (server shutdown). Idempotent. */
  stopIdleReapTimer(): void {
    this.idleReapStop?.();
    this.idleReapStop = null;
  }

  // ─── per-sessionKey serialization (§4.0) ──────────────────────────────────────

  /** Serialize an operation on one sessionKey so submit/kill/readNew never interleave. */
  private enqueue<T>(sessionKey: string, op: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = prior.then(op, op);
    // Keep the chain but swallow rejection so a failed op doesn't poison the queue.
    this.queues.set(
      sessionKey,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  // ─── launch (§4.1 + §4.1.0a single-active-user gate) ──────────────────────────

  async launch(sessionKey: string, params: RpcLaunchParams): Promise<RpcLaunchResult> {
    if (!params.replayBatch || !params.replayAttemptId) {
      return this.launchOnce(sessionKey, params);
    }
    const key = sanitizeSessionKey(sessionKey);
    const digest = createHash("sha256").update(params.replayBatch).digest("hex");
    let ledger = this.replayLaunches.get(key);
    if (!ledger) {
      ledger = new Map();
      this.replayLaunches.set(key, ledger);
    }
    const existing = ledger.get(params.replayAttemptId);
    if (existing) {
      if (existing.digest !== digest) throw new BadSubmitAttemptError();
      return existing.promise;
    }
    const promise = this.launchOnce(key, params);
    ledger.set(params.replayAttemptId, { digest, promise });
    return promise;
  }

  /**
   * #1554 — refresh the shared live-config holder from a launch's params. This is the ONLY way the
   * api's DB-backed persistent-runtime settings reach the cli-runner (it has no DB access and the
   * sanitized child env deliberately carries no app config), so an operator flipping
   * `chat.persistent_runtime.enabled` / the cap / the idle window takes effect on the next launch
   * with no redeploy. Absent fields are sticky: they mean "the api didn't say", not "off/zero".
   */
  applyPersistentRuntimeParams(params: RpcLaunchParams): void {
    const live = this.deps.persistentLiveConfig;
    if (!live) return;
    if (typeof params.persistentRuntimeEnabled === "boolean") {
      live.enabled = params.persistentRuntimeEnabled;
    }
    live.poolCap = positiveIntOr(params.persistentPoolCap, live.poolCap);
    live.idleReapMinutes = positiveIntOr(params.persistentIdleReapMinutes, live.idleReapMinutes);
  }

  private async launchOnce(sessionKey: string, params: RpcLaunchParams): Promise<RpcLaunchResult> {
    this.applyPersistentRuntimeParams(params);
    const key = sanitizeSessionKey(sessionKey);

    // (1) ADMISSION under the server-wide mutex. Compute liveKeys = mux ∪ reservations
    // and admit only if no DIFFERENT key is live; then atomically reserve K. This closes
    // the cross-key concurrent-launch TOCTOU (two launches both passing the gate before
    // either's jarv1s-live-<K> session exists).
    const release = await this.admissionMutex.acquire();
    // #347: declared before the try so it is accessible after the mutex block.
    let sessionIo = this.deps.io;
    try {
      if (this.deps.singleUser) {
        const liveKeys = await this.currentLiveKeys();
        for (const live of liveKeys) {
          if (live !== key) {
            throw new CliChatUnavailableError("live chat is busy with another session");
          }
        }
        // §L.6.1 UNIFIED exclusivity gate: a chat launch is also blocked while a provider login
        // is in flight (the login CLI runs same-UID and touches the auth volume — "at most one
        // untrusted CLI at a time", the #347 stand-in). Reuses the `unavailable` code, no wire change.
        if (this.deps.loginService && (await this.deps.loginService.isLoginActive())) {
          throw new CliChatUnavailableError("a provider login is in progress");
        }
      }
      // #347: allocate the UID slot under the mutex so concurrent launches for different users
      // cannot race on the slot file (the read-modify-write is not atomic end-to-end, only the
      // final tmp→rename is). Done before reservations.add so a slot-allocation failure leaves no
      // orphan reservation. Falls back to the shared root io when homeBase is absent (test /
      // in-process host scenarios).
      //
      // Gated on `perUserUid` (default OFF): when off, `sessionIo` stays as `this.deps.io`, so the
      // CLI runs as the cli-runner's own process UID (the host operator uid that owns the auth +
      // neutral volumes) — no setuid, no foreign-uid spawn into a uid-1000-owned dir. The per-user
      // setuid path requires a root container AND the (in-progress) file-permission model; see the
      // `perUserUid` doc on EngineHostDeps.
      if (this.deps.perUserUid && this.deps.homeBase) {
        const slot = allocateUidSlot(this.deps.homeBase, key);
        const neutralDirForMigration = deriveNeutralDir(this.deps.neutralBase, key);
        migrateNeutralDir(neutralDirForMigration, slot.uid, slot.gid);
        sessionIo = createSanitizedTmuxIo(process.env, slot);
      }
      this.reservations.add(key);
    } catch (err) {
      if (err instanceof CliChatUnavailableError) throw err;
      throw new CliChatUnavailableError(
        err instanceof Error ? err.message : "could not allocate UID slot"
      );
    } finally {
      release();
    }

    // (2) Out-of-lock mux-create + launch, BOUNDED by a timeout (§4.1.0a). The finally
    // releases the reservation on success OR any failure OR timeout — a wedged tmux can
    // never strand K and freeze the gate (fail-safe; release guaranteed by settle AND
    // by timeout).

    // #1350: the engine is chosen by the ONE shared selector, so a provider configured
    // `non_interactive` gets the one-shot (`claude -p` / agy exec) engine here exactly as it
    // does in the in-process factory. Before this the runner ALWAYS built the tmux REPL
    // engine, which made #1239's flip a no-op on every containerized deploy and took prod
    // chat down completely.
    const engine = await createChatEngine(params.provider as ProviderKind, key, sessionIo, {
      mux: this.deps.mux,
      homeBase: this.deps.homeBase,
      ownsDrain: true,
      executionMode: params.executionMode,
      needsStructuredOutput: params.needsStructuredOutput,
      // #1554: the pin is lifted — the RPC root selects the persistent adapter when a pool was
      // wired in AND `chat.persistent_runtime.enabled` is currently on. The flag arrives per
      // launch in the RPC params (the plan's live-reload channel for this topology), so flipping
      // it drains to the bounded-fallback engine on the next launch without a redeploy. With no
      // live-config holder wired, pool presence alone gates it (pre-#1554 behavior).
      persistentRuntimeEnabled:
        this.deps.persistentRuntimePool !== undefined &&
        (this.deps.persistentLiveConfig?.enabled ?? true),
      persistentPool: this.deps.persistentRuntimePool,
      // #363: the 0600 token file the claude launch reads CLAUDE_CODE_OAUTH_TOKEN from at
      // runtime (claude-scoped; only used by buildClaudeCommand, only if the file exists).
      credentialFile: this.deps.homeBase
        ? providerTokenPath(this.deps.homeBase, params.provider)
        : undefined,
      // #1157: surface silently-discarded composer input (char count only — never content) so
      // a stuck previous turn is visible in daemon logs instead of vanishing without a trace.
      onDiagnostic: (event) =>
        console.warn(`[engine-host] ${key} diagnostic ${event.kind} paneChars=${event.paneChars}`)
    });
    const neutralDir = deriveNeutralDir(this.deps.neutralBase, key);

    // #342: seed the provider CLI's first-run state (claude onboarding + per-dir trust) BEFORE
    // launch so the engine-launched REPL skips its wizard and starts authenticated (the token is
    // already injected via the launch line). Per-provider; non-claude providers no-op.
    if (this.deps.homeBase) {
      await ensureProviderLaunchReady(
        this.deps.homeBase,
        params.provider as ProviderKind,
        neutralDir
      );
    }

    // Review B4 follow-up — `params.schema` present means this is a structured one-shot call
    // (email extraction via `CliStructuredAdapter`). `createChatEngine` already built the bounded
    // print engine for it (`needsStructuredOutput` above), so the launch call itself must be
    // `launchStructured`, not the ordinary `launch` — the ordinary one never spawns the
    // JSON-stream child process the structured submit/read verbs below depend on.
    if (params.schema && !hasStructuredMethods(engine)) {
      this.reservations.delete(key);
      throw new CliChatUnavailableError("CLI structured stream is unavailable");
    }
    const launchOpts = {
      neutralDir,
      // The in-process engine ignores personaPath when personaText is present; pass a
      // path under the neutral dir to keep types satisfied (§4.1.1a — server writes
      // the persona FILE from personaText).
      personaPath: `${neutralDir}/persona.md`,
      personaText: params.personaText,
      mcpToken: params.mcpToken,
      mcpServerUrl: params.mcpServerUrl,
      replayBatch: params.replayBatch,
      replayAttemptId: params.replayAttemptId,
      // #367: forward the resolved model id so buildClaudeCommand emits `--model <id>`.
      model: params.model
    };
    // Keep a handle on the RAW launch promise (separate from the timeout race) so that a
    // mux-create which SUCCEEDS *after* the timeout already released the reservation can be
    // reaped immediately — we do not wait for the startup sweep or the api §5.3 reconcile.
    const launchPromise =
      params.schema && hasStructuredMethods(engine)
        ? engine.launchStructured({ ...launchOpts, schema: params.schema })
        : engine.launch(launchOpts);

    let timedOut = false;
    try {
      const result = await this.withTimeout(launchPromise, this.launchTimeoutMs, () => {
        timedOut = true;
      });
      // mux-create SUCCEEDED in time: register the engine so submit/readNew/kill route here.
      this.engines.set(key, engine);
      this.submitAttempts.delete(key);
      this.tombstoneOrder.delete(key);
      return { offset: result.offset };
    } catch (err) {
      // POST-mux-create failure handling is done inside engine.launch (it kills the mux
      // session by canonical name BEFORE removing the dir, §6.5). For a TIMEOUT the engine
      // may still be mid-create; best-effort kill the canonical name + remove the dir so a
      // late orphan can't enter liveKeys and block the gate (§4.1.0a).
      await killMuxSessionByName(this.deps.io, key, this.deps.homeBase).catch(() => undefined);
      await removeNeutralDir(this.deps.io, this.deps.neutralBase, key).catch(() => undefined);
      this.engines.delete(key);
      // LATE-SUCCESS ORPHAN REAP (§4.1.0a, ~the 144-147 race): when we timed out, the raw
      // launch promise is still running and may create the jarv1s-live-<key> mux session
      // AFTER the catch's one-shot kill (which fired before the create finished). Attach a
      // continuation that kills the late orphan the instant the launch settles — so a wedged
      // tmux that frees up late can never strand a foreign live session that blocks the gate.
      if (timedOut) {
        void launchPromise
          .then(
            () => true, // resolved late = a live mux session now exists; reap it
            () => false // rejected late = no late session created; nothing to reap
          )
          .then(async (resolvedLate) => {
            if (!resolvedLate) return;
            await killMuxSessionByName(this.deps.io, key, this.deps.homeBase).catch(
              () => undefined
            );
            await removeNeutralDir(this.deps.io, this.deps.neutralBase, key).catch(() => undefined);
            this.engines.delete(key);
          });
      }
      if (err instanceof CliChatUnavailableError) throw err;
      throw new CliChatUnavailableError("could not start the live chat session");
    } finally {
      this.reservations.delete(key);
    }
  }

  /** §4.1.0a: liveKeys = MUX enumeration ∪ reservations ∪ engine-registry keys. */
  private async currentLiveKeys(): Promise<Set<string>> {
    const byMux = await listLiveMuxSessions(this.deps.io, this.deps.homeBase);
    const set = new Set<string>(byMux);
    for (const r of this.reservations) set.add(r);
    for (const key of this.engines.keys()) set.add(key);
    return set;
  }

  // ─── submit / readNew / isAlive (per-sessionKey serialized) ───────────────────

  async submit(sessionKey: string, params: RpcSubmitParams): Promise<void> {
    const key = sanitizeSessionKey(sessionKey);
    const digest = createHash("sha256").update(params.text).digest("hex");
    let ledger = this.submitAttempts.get(key);
    if (!ledger) {
      ledger = new Map();
      this.submitAttempts.set(key, ledger);
    }
    const existing = ledger.get(params.attemptId);
    if (existing) {
      if (existing.digest !== null && existing.digest !== digest) {
        throw new BadSubmitAttemptError();
      }
      if (existing.digest === null) {
        existing.digest = digest;
        return Promise.reject(new VerifiedSubmitError("unavailable"));
      }
      return existing.promise ?? Promise.reject(new VerifiedSubmitError("unavailable"));
    }

    const attempt: SubmitAttempt = { digest, controller: new AbortController() };
    ledger.set(params.attemptId, attempt);
    const timer = setTimeout(() => attempt.controller.abort(), this.verifiedSubmitTimeoutMs);
    timer.unref?.();
    attempt.promise = this.enqueue(key, async () => {
      try {
        if (attempt.controller.signal.aborted) throw new VerifiedSubmitError("unavailable");
        const engine = this.engines.get(key);
        if (!engine) throw new NotLaunchedError();
        if (engine.provider === "google" || !hasVerifiedSubmit(engine)) {
          // Two engines land here. AGY's real transcript schema cannot use the out-of-scope
          // Gemini CLI ACK reader; and the one-shot engines (#1350) have NO multiplexer pane
          // to echo-verify against — each turn is its own `claude -p` process, so the process
          // spawning IS the delivery. Ledger idempotency remains the duplicate-submit guard
          // for both.
          await engine.submit(params.text);
          if (attempt.controller.signal.aborted) throw new VerifiedSubmitError("unavailable");
        } else {
          await engine.verifiedSubmit({
            attemptId: params.attemptId,
            text: params.text,
            signal: attempt.controller.signal
          });
        }
      } catch (err) {
        if (err instanceof VerifiedSubmitError && err.engineInvalidated) {
          this.engines.delete(key);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    });
    return attempt.promise;
  }

  /** Out-of-queue cancellation: aborts queued/active attempts immediately and idempotently. */
  async cancelSubmit(sessionKey: string, params: RpcCancelSubmitParams): Promise<void> {
    const key = sanitizeSessionKey(sessionKey);
    let ledger = this.submitAttempts.get(key);
    if (!ledger) {
      ledger = new Map();
      this.submitAttempts.set(key, ledger);
    }
    let attempt = ledger.get(params.attemptId);
    if (!attempt) {
      attempt = { digest: null, controller: new AbortController() };
      ledger.set(params.attemptId, attempt);
      this.boundSyntheticTombstones(key, ledger, params.attemptId);
    }
    attempt.controller.abort();
  }

  /** #1525: track a freshly created cancel-before-submit tombstone and evict the oldest one(s)
   *  once the per-session FIFO exceeds the 128 ceiling. Only evicts entries still `digest ===
   *  null` — an entry `submit()` has since upgraded to a real digest is no longer a synthetic
   *  tombstone and survives. */
  private boundSyntheticTombstones(
    key: string,
    ledger: Map<string, SubmitAttempt>,
    attemptId: string
  ): void {
    let order = this.tombstoneOrder.get(key);
    if (!order) {
      order = [];
      this.tombstoneOrder.set(key, order);
    }
    order.push(attemptId);
    while (order.length > CliChatEngineHost.MAX_SYNTHETIC_TOMBSTONES) {
      const oldestId = order.shift() as string;
      const oldest = ledger.get(oldestId);
      if (oldest && oldest.digest === null) ledger.delete(oldestId);
    }
  }

  readNew(sessionKey: string, afterOffset: number): Promise<RpcReadNewResult> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      if (!engine) throw new NotLaunchedError();
      const { records, offset, complete } = await engine.readNew(afterOffset);
      return { records, offset, complete };
    });
  }

  /** Review B4 follow-up — structured one-shot submit, mirrors `readNew`/`submit`'s enqueue shape. */
  submitStructured(sessionKey: string, text: string): Promise<RpcSubmitStructuredResult> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      if (!engine) throw new NotLaunchedError();
      if (!hasStructuredMethods(engine)) {
        throw new CliChatUnavailableError("CLI structured stream is unavailable");
      }
      await engine.submitStructured(text);
      return { ok: true as const };
    });
  }

  /** Review B4 follow-up — structured one-shot poll, mirrors `readNew`'s enqueue shape. */
  readStructured(sessionKey: string, afterOffset: number): Promise<RpcReadStructuredResult> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      if (!engine) throw new NotLaunchedError();
      if (!hasStructuredMethods(engine)) {
        throw new CliChatUnavailableError("CLI structured stream is unavailable");
      }
      return engine.readStructured(afterOffset);
    });
  }

  isAlive(sessionKey: string): Promise<boolean> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      // No engine for the key ⇒ not alive (mirrors handle===null returning false, §4.3).
      if (!engine) return false;
      return engine.isAlive();
    });
  }

  interrupt(sessionKey: string): Promise<void> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      if (!engine) throw new NotLaunchedError();
      await engine.interrupt();
    });
  }

  // ─── kill (§4.5) — works WITHOUT an engine object (kill-by-mux-name) ───────────

  kill(sessionKey: string, opts: RpcKillParams = {}): Promise<void> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      if (engine) {
        // Failed private purge kills the process but retains its exact marker for the boot sweep.
        await engine.kill(opts);
        this.engines.delete(key);
        this.submitAttempts.delete(key);
        this.tombstoneOrder.delete(key);
        this.replayLaunches.delete(key);
        return;
      }
      // Post-restart orphan: no engine object, but a live jarv1s-live-<key> mux session
      // may still exist. Kill by canonical name; preserve a failed-purge marker when requested.
      await killMuxSessionByName(this.deps.io, key, this.deps.homeBase);
      if (!opts.preserveNeutralDir) {
        await removeNeutralDir(this.deps.io, this.deps.neutralBase, key);
      }
      this.submitAttempts.delete(key);
      this.tombstoneOrder.delete(key);
      this.replayLaunches.delete(key);
    });
  }

  // ─── purgeTranscripts (#744) — private-chat transcript purge; engine-less is NORMAL ──
  //
  // Private cleanup purges BEFORE kill so the resident engine can use its exact in-memory identity.
  // Engine-less purge remains the boot-sweep recovery path after a crash. Serialized on the per-key
  // queue so a purge never interleaves a launch/submit for the same session.
  purgeTranscripts(sessionKey: string): Promise<void> {
    const key = sanitizeSessionKey(sessionKey);
    return this.enqueue(key, async () => {
      const engine = this.engines.get(key);
      // #1350: `purgeTranscripts` is optional on CliChatEngine — the one-shot engines don't
      // implement it. Falling through to the engine-less sweep is correct for them: it purges
      // the same neutral-dir/home-base transcript tree the print engine writes into.
      if (engine?.purgeTranscripts) {
        await engine.purgeTranscripts();
        return;
      }
      await purgePrivateTranscripts(this.deps.io, this.deps.neutralBase, key, this.deps.homeBase);
    });
  }

  // ─── listLiveSessions (§4.6) — by mux, NOT the engine Map ──────────────────────

  async listLiveSessions(): Promise<string[]> {
    return listLiveMuxSessions(this.deps.io, this.deps.homeBase);
  }

  // ─── probeProvider (§4.8) — no token, no replay ───────────────────────────────

  async probeProvider(provider: RpcProviderKind): Promise<RpcProbeProviderResult> {
    const result: ProbeProviderResult = await probeProvider(provider as ProviderKind, {
      io: this.deps.io,
      cliPresent: this.deps.cliPresent,
      multiplexerUsable: this.deps.multiplexerUsable,
      // #363: inject the persisted claude OAuth token so `auth status` reports loggedIn.
      credentialEnv: this.deps.homeBase
        ? await readProviderCredentialEnv(this.deps.homeBase, provider)
        : undefined,
      homeBase: this.deps.homeBase
    });
    return { status: result.status, message: result.message };
  }

  // ─── listProviderModels (#2208) — non-session; credential never crosses the socket ───

  /** Built on first use: `codex --version` is read at most once per runner process. */
  private readCodexVersion: (() => Promise<string | undefined>) | undefined;

  /**
   * #2208: ask the provider's vendor for its live model list using the credential the runner
   * already holds on the cli-auth volume. Only ids cross the socket; a missing credential is
   * `not_logged_in`, a vendor/transport failure is a plain `error`, gemini is `unsupported`.
   * Not gated by the §L.6.1 exclusivity mutex: it reads a file and makes one HTTPS call, never
   * touching tmux or the CLI's own state.
   */
  async listProviderModels(provider: RpcProviderKind): Promise<RpcListProviderModelsResult> {
    this.readCodexVersion ??= createCodexVersionReader(this.deps.io);
    return listProviderModels(provider, {
      homeBase: this.deps.homeBase,
      fetch: this.deps.fetch,
      io: this.deps.io,
      codexVersion: this.readCodexVersion
    });
  }

  // ─── installProvider (§A.2.4) — delegates to the install service ──────────────

  /**
   * §A.2.4: delegate to the §A.3 install service. Does NOT pass through the
   * per-sessionKey queue (no session) nor the §4.1.0a admission mutex (no live engine —
   * the install lane is volume-disjoint from admission, §A.5.1); the service takes its
   * OWN per-provider lock (§A.3.1). A failed install is a TERMINAL OUTCOME
   * `{state:"error"}` (not a throw); a blocked/in-flight provider throws
   * `InstallBadRequestError` (mapped to bad_request by connection.ts).
   */
  async installProvider(provider: RpcProviderKind): Promise<RpcInstallProviderResult> {
    if (!this.deps.installService) {
      // No installer wired (e.g. a host-mode build) — surface a terminal error outcome
      // rather than a throw, so the api persists `error` and offers a retry.
      return { state: "error", message: "install service unavailable on this build" };
    }
    return this.deps.installService.installProvider(provider);
  }

  // ─── login verbs (§L.2) — non-session; unified §L.6.1 exclusivity gate ─────────

  /**
   * §L.2.2 beginLogin: admit ONLY when no live chat session AND no other login is in flight
   * (the §L.6.1 unified exclusivity gate, under the SAME admission mutex as launch). Reserve the
   * single login slot inside the lock, then start the flow outside it. A blocked/no-adapter
   * provider throws `LoginBadRequestError` (→ bad_request); a chat/login-busy rejection throws
   * `CliChatUnavailableError` (→ unavailable). No wire-contract change.
   */
  async beginLogin(provider: RpcProviderKind): Promise<RpcBeginLoginResult> {
    const svc = this.deps.loginService;
    if (!svc) throw new LoginBadRequestError("login not available on this build");
    if (!svc.hasAdapter(provider)) {
      throw new LoginBadRequestError("provider not loginable: no login adapter");
    }
    let loginId: string;
    const release = await this.admissionMutex.acquire();
    try {
      if (this.deps.singleUser && (await this.currentLiveKeys()).size > 0) {
        throw new CliChatUnavailableError("live chat is busy with another session");
      }
      // One login at a time regardless of the single-user flag (one flow slot, §L.3.1).
      if (await svc.isLoginActive()) {
        throw new CliChatUnavailableError("a provider login is already in progress");
      }
      loginId = svc.reserve(provider); // SYNC slot claim inside the lock (§L.6.1)
    } finally {
      release();
    }
    // Start the flow OUTSIDE the lock (the reservation holds the slot). On any failure the
    // service clears the flow + reaps the session (§L.3.1).
    return svc.start(loginId);
  }

  /** §L.2.3 pollLogin — re-derive status (probe + runtime smoke); a stale loginId ⇒ bad_request. */
  pollLogin(provider: RpcProviderKind, loginId: string): Promise<RpcPollLoginResult> {
    return this.requireLogin().poll(provider, loginId);
  }

  /** §L.2.3 submitLoginToken — feed the pasted code argv-free (§L.6.3); a stale loginId ⇒ bad_request. */
  submitLoginToken(
    provider: RpcProviderKind,
    loginId: string,
    token: string
  ): Promise<RpcSubmitLoginTokenResult> {
    return this.requireLogin().submitToken(provider, loginId, token);
  }

  /** §L.2.3 cancelLogin — kill the login session + release the slot. Idempotent. */
  async cancelLogin(provider: RpcProviderKind, loginId: string): Promise<RpcCancelLoginResult> {
    await this.requireLogin().cancel(provider, loginId);
    return { ok: true };
  }

  private requireLogin(): LoginService {
    if (!this.deps.loginService)
      throw new LoginBadRequestError("login not available on this build");
    return this.deps.loginService;
  }

  /**
   * v0.1.3 max-age login reaper (driven periodically by the server). Delegates to the login
   * service's {@link LoginService.reapStaleLogins}; a no-op when no login service is wired. Does
   * NOT acquire the admission mutex — it only mutates the login service's own flow + kills a stale
   * tmux session, and the next gate check reads fresh disk liveness. Best-effort: never throws.
   */
  async reapStaleLogins(maxAgeMs?: number): Promise<void> {
    await this.deps.loginService?.reapStaleLogins(maxAgeMs).catch(() => undefined);
  }

  // ─── startup CLEAN-SLATE sweep (§4.1.0a (2) / §6.5) ───────────────────────────

  /**
   * BEFORE accepting connections: kill every `jarv1s-live-*` mux session that exists,
   * purge every marker-backed private transcript to completion, then clear residual
   * neutral dirs. A container restart kills the forked tmux server while token dirs
   * persist on the volume, so a mux-only sweep misses them. The gate guarantees ≤1 live
   * session, so a fresh process legitimately has zero — the base is cleared wholesale
   * only after purge succeeds.
   */
  async startupSweep(): Promise<void> {
    // (a) kill any surviving mux sessions (rare after a container restart, but a fast
    // in-place restart can leave them).
    const live = await listLiveMuxSessions(this.deps.io, this.deps.homeBase).catch(
      () => [] as string[]
    );
    for (const key of live) {
      await killMuxSessionByName(this.deps.io, key, this.deps.homeBase).catch(() => undefined);
    }
    // (b) purge every marker-backed private transcript before the neutral dirs are erased.
    const purged = await purgePrivateTranscriptMarkers(
      this.deps.io,
      this.deps.neutralBase,
      this.deps.homeBase
    );
    if (purged) {
      // (c) once every pointed-to transcript is confirmed purged, remove residual neutral dirs.
      await this.clearNeutralBase();
    }
    // (d) §A.3.2 install-service tools-volume sweep (DISTINCT from the auth-volume sweep
    // above): clear orphaned `.staging/*` AND GC releases not referenced by `current`.
    // Ordered here so it completes BEFORE the server accepts the first installProvider
    // (the server runs startupSweep before listen, server.ts:41).
    await this.deps.installService?.startupSweep().catch(() => undefined);
    // (d.1) #1081 H1: boot-time drift reconcile — re-verify every ALREADY-installed
    // provider's live binary against the current catalog (a rebaked recipe whose binary
    // is stuck stale in the persistent tools volume gets reinstalled here; an
    // already-current or never-installed provider is untouched). Runs after the GC sweep
    // above and before the server accepts its first request.
    await this.deps.installService?.reconcileInstalledProviders().catch(() => undefined);
    // (e) §L.3.4 login-session sweep: kill every `jarv1s-login-*` mux session (a fast in-place
    // restart can leave one while the in-memory login flow is gone). DISTINCT from (a), which
    // only enumerates `jarv1s-live-*` chat sessions.
    await this.deps.loginService?.startupSweep().catch(() => undefined);
  }

  /** `rm -rf <neutralBase>/* ` then recreate the base dir (`0700`). */
  private async clearNeutralBase(): Promise<void> {
    // Remove children individually (not the base itself) so the mount point/volume root
    // is preserved; recreate the base so the first launch's mkdir -p is a no-op.
    const listed = await this.deps.io.run("ls", ["-A", this.deps.neutralBase]).catch(() => ({
      code: 1,
      stdout: ""
    }));
    if (listed.code === 0) {
      for (const name of listed.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        await this.deps.io
          .run("rm", ["-rf", `${this.deps.neutralBase}/${name}`])
          .catch(() => undefined);
      }
    }
    await this.deps.io.run("mkdir", ["-p", this.deps.neutralBase]).catch(() => undefined);
    await this.deps.io.run("chmod", ["700", this.deps.neutralBase]).catch(() => undefined);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────────

  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    onTimeout?: () => void
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error("launch timed out"));
          }, ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Test/introspection helper: how many engines are registered. */
  liveEngineCount(): number {
    return this.engines.size;
  }
}

/**
 * #1350 — does this engine drive a multiplexer pane it can echo-verify a submit against?
 * Only `CliChatEngineImpl` does; the one-shot print engines spawn a fresh process per turn and
 * have no pane to read back, so they take the plain `submit` path.
 */
function hasVerifiedSubmit(engine: CliChatEngine): engine is CliChatEngineImpl {
  return typeof (engine as Partial<CliChatEngineImpl>).verifiedSubmit === "function";
}

/**
 * Review B4 follow-up — mirrors `hasVerifiedSubmit`'s feature-detect pattern. Only the bounded
 * print engine (`ClaudePrintChatEngine`, built by `createChatEngine` whenever
 * `needsStructuredOutput` is set) implements these three methods.
 */
type StructuredCapableEngine = CliChatEngine & {
  launchStructured(
    opts: Parameters<CliChatEngine["launch"]>[0] & { readonly schema: Record<string, unknown> }
  ): Promise<{ readonly offset: number }>;
  submitStructured(text: string): Promise<void>;
  readStructured(afterOffset: number): Promise<RpcReadStructuredResult>;
};

function hasStructuredMethods(engine: CliChatEngine): engine is StructuredCapableEngine {
  const e = engine as Partial<StructuredCapableEngine>;
  return (
    typeof e.launchStructured === "function" &&
    typeof e.submitStructured === "function" &&
    typeof e.readStructured === "function"
  );
}

/** Internal marker mapped to RpcErr code "not_launched" by the dispatcher. */
export class NotLaunchedError extends Error {
  constructor() {
    super("no live session for this sessionKey");
    this.name = "NotLaunchedError";
  }
}

export class BadSubmitAttemptError extends Error {
  constructor() {
    super("attemptId was already used with a different payload");
    this.name = "BadSubmitAttemptError";
  }
}
