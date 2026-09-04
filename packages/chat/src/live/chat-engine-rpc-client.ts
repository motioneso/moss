/**
 * ChatEngineRpcClient — the api-side RPC client for the cli-runner sidecar (#342).
 *
 * The api no longer runs the provider CLIs in-process. Instead it drives a dedicated `cli-runner`
 * container over a private Unix-domain socket. This module is the api half of that boundary:
 *
 *   - `RpcConnection` owns the ONE long-lived socket: connect/reconnect with backoff, the §3.6 mutual
 *     challenge-response auth hello (the RPC secret is NEVER sent on the wire), length-prefixed-JSON
 *     framing (§3.2), id-matching of responses over one connection (§3.4), and §5.6 `bootId` tracking
 *     (records the first bootId; on a change it fails in-flight calls and fires a reconciliation hook
 *     the manager wires).
 *   - `ChatEngineRpcClient` is a thin per-`sessionKey` wrapper implementing `CliChatEngine`
 *     (launch/submit/readNew/isAlive/kill) by marshalling each method onto the shared connection.
 *
 * SECURITY (§6.4): NO raw frame logging on either side. The launch frame carries the MCP token + the
 * persona/replay (private content) and the hello frame carries the socket secret. The only loggable
 * fields for a frame are `{ method, id, sessionKey, bytes }` — never params/result/error bodies.
 *
 * Wire types are imported READ-ONLY from `./rpc-contract.js` (the frozen wire-type home, §10) — this
 * module re-declares none of them.
 */

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";

import type { ProviderKind } from "@moss/ai";
import { resolveMossEnv } from "@moss/db";
import { parsePositiveIntEnv } from "@moss/shared";
import type { AiProviderExecutionMode } from "@moss/shared";

import { CliChatDeliveryUnknownError, CliChatUnavailableError } from "./errors.js";
import type { RpcInstallProviderParams, RpcInstallProviderResult } from "./install-contract.js";
import type {
  RpcBeginLoginParams,
  RpcBeginLoginResult,
  RpcCancelLoginParams,
  RpcCancelLoginResult,
  RpcPollLoginParams,
  RpcPollLoginResult,
  RpcSubmitLoginTokenParams,
  RpcSubmitLoginTokenResult
} from "./login-contract.js";
// #1059 — the §3.6 client hello now lives in ./rpc-handshake.ts (shared with TerminalRpcClient);
// this module delegates to it rather than owning the handshake body.
import { performClientHello } from "./rpc-handshake.js";
import {
  decodeFrame,
  encodeFrame,
  type RpcCancelSubmitParams,
  type RpcCancelSubmitResult,
  type RpcErr,
  type RpcErrorCode,
  type RpcFrame,
  type RpcInterruptResult,
  type RpcIsAliveResult,
  type RpcKillParams,
  type RpcKillResult,
  type RpcLaunchParams,
  type RpcLaunchResult,
  type RpcListLiveSessionsResult,
  type RpcListProviderModelsParams,
  type RpcListProviderModelsResult,
  type RpcMethod,
  type RpcOk,
  type PersistentRuntimeLaunchConfig,
  type RpcProbeProviderParams,
  type RpcProbeProviderResult,
  type RpcPurgeTranscriptsResult,
  type RpcReadNewParams,
  type RpcReadNewResult,
  type RpcSubmitParams,
  type RpcSubmitResult,
  type ReapReason
} from "./rpc-contract.js";
import type { CliChatEngine, EngineKillOpts, EngineLaunchOpts, TranscriptRecord } from "./types.js";

/** The directory the socket MUST resolve under (§3.1 client-side realpath guard). */
export const SOCKET_ALLOWED_DIR = "/run/jarv1s";

/** Reconnect backoff bounds (§3.5): 250ms → 2s, jittered. */
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 2_000;

/**
 * §3.4 per-call response deadline (ms). A cli-runner that ACCEPTS a request frame but never sends
 * its response (a wedged provider CLI whose transcript never reaches a complete boundary) would
 * otherwise leave the api-side promise pending FOREVER: the socket stays open, so neither
 * `failAllInFlight` nor a reconnect ever fires. For a chat turn that hung promise also wedges the
 * per-user turn-in-flight lock permanently, so every later turn 409s "a chat turn is already in
 * progress" until the api restarts (#445). After the deadline the call rejects with a retryable
 * CliChatUnavailableError (→ HTTP 503) and its pending entry is cleaned up so nothing leaks.
 *
 * Applies to the turn verbs (submit/readNew/isAlive/kill). Override with
 * JARVIS_CLI_RUNNER_RPC_TIMEOUT_MS (ms); pass `callTimeoutMs: 0` to RpcConnection to disable.
 */
const DEFAULT_RPC_TIMEOUT_MS = 45_000;

/**
 * Deadline for `launch` — looser than the turn verbs because a launch spawns the CLI, writes the
 * persona, and submits + server-drains the replay batch before replying. Never below the turn
 * deadline. The long-running, server-budgeted verbs (installProvider, login*, probeProvider) get NO
 * client deadline — they legitimately run for minutes and own their own server-side timeouts.
 */
const LAUNCH_RPC_TIMEOUT_MS = 120_000;

/** A minimal sink for the {method,id,sessionKey,bytes}-only debug log (§6.4). NEVER bodies. */
export interface RpcClientLogger {
  debug(fields: {
    method?: RpcMethod | "hello";
    id?: number;
    sessionKey?: string;
    bytes?: number;
  }): void;
  warn(message: string): void;
}

const NOOP_LOGGER: RpcClientLogger = { debug: () => {}, warn: () => {} };

/**
 * The RPC surface the reconciliation routine (§5.3) is allowed to drive WHILE reconciliation is in
 * progress. Critically, these calls BYPASS the `reconciling` guard that `call()` applies to every
 * normal RPC — without this the reconciliation flow would self-deadlock: §5.3 step 1 must issue
 * `listLiveSessions()` to obtain `liveKeys` and step 4 must issue `kill()` for each api-unknown live
 * mux session, but both route through `call()`, which rejects with `CliChatUnavailableError`
 * ("cli-runner reconciling after restart") while `reconciling === true`. The hook therefore receives
 * THIS driver (not the public connection) and issues its own RPCs through it.
 *
 * Only the two verbs reconciliation actually needs are exposed (`listLiveSessions` + `kill`); the
 * guard-bypass is deliberately NOT available to general callers (the public `RpcConnection.kill` /
 * `listLiveSessions` stay blocked during reconcile, so a normal turn cannot sneak past the gate).
 */
export interface RpcReconcileDriver {
  /** §4.6 reconciliation primitive — the authoritative live-key enumeration. Bypasses the gate. */
  listLiveSessions(): Promise<RpcListLiveSessionsResult>;
  /** §4.5 kill-by-mux-name for an orphaned live session. Bypasses the gate. */
  kill(sessionKey: string, opts?: RpcKillParams): Promise<RpcKillResult>;
}

export interface RpcConnectionOpts {
  /** Absolute socket path; realpath-checked to be under /run/jarv1s before connect (§3.1). */
  readonly socketPath: string;
  /** Shared secret for the §3.6 auth hello. Proven over nonces, NEVER sent on the wire. */
  readonly rpcSecret: string;
  /**
   * Reconciliation hook fired on every (re)connect AND on a detected bootId change (§5.6). The
   * manager (Lane D) wires this to `reconcileLiveSessions`. While it runs, new (normal) calls are
   * blocked — but the hook is handed an {@link RpcReconcileDriver} whose `listLiveSessions`/`kill`
   * RPCs BYPASS that block, so the reconciliation routine (§5.3 steps 1+4) can complete over the
   * same connection without self-deadlocking.
   */
  readonly onReconcile?: (driver: RpcReconcileDriver) => Promise<void>;
  /**
   * #1554 Decision 2 — fired on an unsolicited `sessionReaped` push (RPC topology's cli-runner-
   * resident persistent runtime pool reaped a session server-side). The manager wires this to
   * `ChatSessionManager.handleRemoteReap`. Absent on the in-process/host path (no separate
   * cli-runner ever sends this push there).
   */
  readonly onSessionReaped?: (sessionKey: string, reason: ReapReason) => void;
  /** {method,id,sessionKey,bytes}-only logger (§6.4). Defaults to a no-op. */
  readonly logger?: RpcClientLogger;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  /**
   * Per-call response deadline (ms) for the turn verbs (submit/readNew/isAlive/kill). Defaults to
   * JARVIS_CLI_RUNNER_RPC_TIMEOUT_MS, else {@link DEFAULT_RPC_TIMEOUT_MS}. Set to 0 to disable all
   * per-call deadlines (test seam — leaves a hung RPC pending forever, as before this guard).
   */
  readonly callTimeoutMs?: number;
}

interface PendingCall {
  readonly method: RpcMethod;
  readonly sessionKey?: string;
  resolve(result: unknown): void;
  reject(err: Error): void;
  /** #456 — re-arm this call's response deadline (activity-aware reset). No-op if the call has no
   *  deadline (turnTimeoutMs <= 0) or has already settled. */
  resetDeadline?: () => void;
}

/** Internal connection state machine. */
type ConnState = "idle" | "connecting" | "handshaking" | "ready" | "closed";

/**
 * Maps an RpcErrorCode to the typed JS error the api expects (§4.7). `unavailable` and `not_launched`
 * both become a retryable `CliChatUnavailableError` (→ HTTP 503); the rest become a plain `Error`
 * (→ 500). The message is already redacted server-side (§6.4), so it is safe to surface/log.
 */
export function mapRpcError(code: RpcErrorCode, message: string): Error {
  if (code === "delivery_unknown") return new CliChatDeliveryUnknownError(message);
  if (code === "unavailable" || code === "not_launched") {
    return new CliChatUnavailableError(message);
  }
  return new Error(message);
}

/**
 * Owns the single long-lived socket to cli-runner. Shared across all per-session `ChatEngineRpcClient`
 * instances (one connection per api process, §3.4). Handles connect/reconnect, the auth hello,
 * framing, id-matching, and bootId reconciliation.
 */
export class RpcConnection {
  private readonly socketPath: string;
  private readonly rpcSecret: string;
  private readonly onReconcile?: (driver: RpcReconcileDriver) => Promise<void>;
  private readonly onSessionReaped?: (sessionKey: string, reason: ReapReason) => void;
  private readonly log: RpcClientLogger;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  /** Per-call response deadline for the turn verbs; ≤0 disables all per-call deadlines. */
  private readonly turnTimeoutMs: number;

  private socket: Socket | null = null;
  private state: ConnState = "idle";
  private recvBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Per-connection monotonic request id (§3.4). Reset on each fresh connection. */
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  /** The first bootId observed on the current connection; a change is a silent restart (§5.6). */
  private bootId: string | null = null;
  /** While true, new RPC calls are rejected as unavailable until reconciliation completes (§5.6). */
  private reconciling = false;

  private connectPromise: Promise<void> | null = null;
  private closedByCaller = false;

  constructor(opts: RpcConnectionOpts) {
    this.socketPath = opts.socketPath;
    this.rpcSecret = opts.rpcSecret;
    this.onReconcile = opts.onReconcile;
    this.onSessionReaped = opts.onSessionReaped;
    this.log = opts.logger ?? NOOP_LOGGER;
    this.reconnectMinMs = opts.reconnectMinMs ?? RECONNECT_MIN_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.turnTimeoutMs =
      opts.callTimeoutMs ??
      parsePositiveIntEnv(
        resolveMossEnv(process.env, "JARVIS_CLI_RUNNER_RPC_TIMEOUT_MS"),
        DEFAULT_RPC_TIMEOUT_MS
      );
  }

  /**
   * Per-call response deadline (ms) by verb; `0` means no deadline. The turn verbs
   * (submit/readNew/isAlive/kill) use {@link turnTimeoutMs}; `launch` gets the looser of that and
   * {@link LAUNCH_RPC_TIMEOUT_MS}. The long-running, server-budgeted verbs (install, login*, probe)
   * and the reconciliation primitive get NO client deadline — they own their own server-side
   * timeouts and can legitimately run for minutes. When `turnTimeoutMs <= 0`, all deadlines off.
   */
  private callTimeoutMs(method: RpcMethod): number {
    if (this.turnTimeoutMs <= 0) return 0;
    switch (method) {
      case "submit":
      case "cancelSubmit":
      case "readNew":
      case "isAlive":
      case "interrupt":
      case "kill":
      case "purgeTranscripts": // #744 — bounded per-session verb, same class as kill
        return this.turnTimeoutMs;
      case "launch":
        // NOTE: JARVIS_CLI_RUNNER_RPC_TIMEOUT_MS raises turnTimeoutMs for ALL turn verbs, not just
        // launch — setting it very high (e.g. minutes) weakens the #445 wedge-recovery it exists
        // for, since a hung submit/readNew then takes that long to free the per-user turn lock.
        // Keep the override modest; it is a ceiling on recovery latency, not just on launch.
        return Math.max(this.turnTimeoutMs, LAUNCH_RPC_TIMEOUT_MS);
      default:
        // installProvider / begin|poll|submit|cancelLogin / probeProvider / listLiveSessions:
        // server-budgeted, may run for minutes — no client-side deadline.
        return 0;
    }
  }

  // ─── public RPC surface ──────────────────────────────────────────────────────

  launch(sessionKey: string, params: RpcLaunchParams): Promise<RpcLaunchResult> {
    return this.call<RpcLaunchResult>("launch", sessionKey, params);
  }

  async submit(sessionKey: string, params: RpcSubmitParams): Promise<RpcSubmitResult> {
    try {
      return await this.call<RpcSubmitResult>("submit", sessionKey, params);
    } catch (err) {
      void this.cancelSubmit(sessionKey, { attemptId: params.attemptId }).catch(() => undefined);
      throw err;
    }
  }

  cancelSubmit(sessionKey: string, params: RpcCancelSubmitParams): Promise<RpcCancelSubmitResult> {
    return this.call<RpcCancelSubmitResult>("cancelSubmit", sessionKey, params);
  }

  readNew(sessionKey: string, params: RpcReadNewParams): Promise<RpcReadNewResult> {
    return this.call<RpcReadNewResult>("readNew", sessionKey, params);
  }

  isAlive(sessionKey: string): Promise<RpcIsAliveResult> {
    return this.call<RpcIsAliveResult>("isAlive", sessionKey, {});
  }

  kill(sessionKey: string, opts: RpcKillParams = {}): Promise<RpcKillResult> {
    return this.call<RpcKillResult>("kill", sessionKey, opts);
  }

  // #744 — private-chat transcript purge over RPC. Runs server-side (the api can't reach the
  // cli-runner's home dir on the split topology); the manager gates its bookkeeping-row delete
  // on this resolving, so a rejection here keeps the row for the boot sweep to retry.
  purgeTranscripts(sessionKey: string): Promise<RpcPurgeTranscriptsResult> {
    return this.call<RpcPurgeTranscriptsResult>("purgeTranscripts", sessionKey, {});
  }

  interrupt(sessionKey: string): Promise<RpcInterruptResult> {
    return this.call<RpcInterruptResult>("interrupt", sessionKey, {});
  }

  /**
   * #456 — re-arm the response deadline for any in-flight turn verb.
   * of the given sessionKey. Called by the manager when it observes new transcript records from a
   * readNew, so an actively-producing turn (many short readNew calls spanning a wall time greater
   * than the per-call deadline) never trips it. A genuinely wedged cli-runner (no activity signal)
   * still trips the deadline and recovers (#445 preserved). No-op if no turn verb is in flight for
   * the session, or if deadlines are disabled (turnTimeoutMs <= 0).
   */
  resetActivityDeadline(sessionKey: string): void {
    const turnVerbs: ReadonlySet<RpcMethod> = new Set([
      "submit",
      "readNew",
      "isAlive",
      "interrupt",
      "kill",
      "purgeTranscripts"
    ]);
    for (const call of this.pending.values()) {
      if (call.sessionKey === sessionKey && turnVerbs.has(call.method)) {
        call.resetDeadline?.();
      }
    }
  }

  /**
   * Non-session reconciliation primitive (§4.6); no sessionKey. The PUBLIC entrypoint is gated by
   * `reconciling` like every other call; the reconciliation routine itself uses the guard-bypassing
   * path via the {@link RpcReconcileDriver} handed to `onReconcile` (see `runReconciliation`).
   */
  listLiveSessions(): Promise<RpcListLiveSessionsResult> {
    return this.call<RpcListLiveSessionsResult>("listLiveSessions", undefined, {});
  }

  /** Non-session onboarding probe (§4.8); no sessionKey. */
  probeProvider(params: RpcProbeProviderParams): Promise<RpcProbeProviderResult> {
    return this.call<RpcProbeProviderResult>("probeProvider", undefined, params);
  }

  /**
   * §A.2 on-demand install verb (additive). NON-SESSION (no sessionKey), exactly like
   * `probeProvider`/`listLiveSessions` — instance-wide, gated solely by the §3.6 auth hello.
   * It is NOT a chat launch: no MCP token, no replay, no neutral-dir write, no single-active-user
   * gate (§A.0).
   *
   * The MVP is a plain single-request/single-response verb (§A.5.1): the server runs the install to
   * completion and returns the TERMINAL {@link RpcInstallProviderResult}. A *failed install* is a
   * normal terminal OUTCOME — an `RpcOk` with `result.state === "error"`, NOT an `RpcErr` (§A.2.3).
   * It therefore resolves (does not reject) with `{ state: "error", message }`. Only a malformed/
   * blocked input (`bad_request` — not a kind, or a `blocked`/absent catalog entry, or an install
   * already in progress) or an unexpected server fault (`internal`) crosses as an `RpcErr`, which
   * `call()` maps to a thrown typed error via {@link mapRpcError} (§4.7).
   */
  installProvider(params: RpcInstallProviderParams): Promise<RpcInstallProviderResult> {
    return this.call<RpcInstallProviderResult>("installProvider", undefined, params);
  }

  /**
   * §L.2 login verbs (additive, Phase 3). NON-SESSION (no sessionKey), exactly like
   * `installProvider` — instance-wide, gated solely by the §3.6 auth hello + the §L.6.1 unified
   * exclusivity gate (server-side). A failed login FLOW is a normal terminal OUTCOME — an `RpcOk`
   * with `status:"error"`, NOT an `RpcErr` (§L.2.4): these resolve (do not reject) with
   * `{ status:"error", message }`. Only a malformed/blocked input (`bad_request` — not a kind, a
   * blocked/no-adapter provider, a stale loginId) or an unexpected server fault (`internal`)
   * crosses as an `RpcErr`, which `call()` maps to a thrown typed error (§4.7).
   *
   * The pasted `token` in submitLoginToken is AUTH MATERIAL (§L.6.3): it crosses ONLY in this
   * socket payload and is never logged (frame bodies are never logged, §6.4) / persisted / echoed.
   */
  beginLogin(params: RpcBeginLoginParams): Promise<RpcBeginLoginResult> {
    return this.call<RpcBeginLoginResult>("beginLogin", undefined, params);
  }

  pollLogin(params: RpcPollLoginParams): Promise<RpcPollLoginResult> {
    return this.call<RpcPollLoginResult>("pollLogin", undefined, params);
  }

  submitLoginToken(params: RpcSubmitLoginTokenParams): Promise<RpcSubmitLoginTokenResult> {
    return this.call<RpcSubmitLoginTokenResult>("submitLoginToken", undefined, params);
  }

  cancelLogin(params: RpcCancelLoginParams): Promise<RpcCancelLoginResult> {
    return this.call<RpcCancelLoginResult>("cancelLogin", undefined, params);
  }

  /**
   * #2208 listProviderModels — NON-SESSION, like probeProvider. The runner asks the provider's
   * vendor for its live model list with the credential it already holds; ONLY ids come back.
   * Every non-ok outcome (not logged in, unsupported, vendor failure) is a normal result, not an
   * `RpcErr`. Server-bounded at 5 s per vendor call, so no client deadline is applied here.
   */
  listProviderModels(params: RpcListProviderModelsParams): Promise<RpcListProviderModelsResult> {
    return this.call<RpcListProviderModelsResult>("listProviderModels", undefined, params);
  }

  /** Tear down the connection (process shutdown). Idempotent. */
  close(): void {
    this.closedByCaller = true;
    this.state = "closed";
    this.failAllInFlight(new CliChatUnavailableError("rpc connection closed"));
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  // ─── core request/response ───────────────────────────────────────────────────

  private async call<T>(
    method: RpcMethod,
    sessionKey: string | undefined,
    params: unknown,
    allowDuringReconcile = false
  ): Promise<T> {
    await this.ensureConnected();
    if (this.reconciling && !allowDuringReconcile) {
      // A bootId change / fresh reconnect is being reconciled; the chat surface is transiently
      // unavailable (HTTP 503, retryable) until it completes (§5.6). The reconciliation routine's
      // OWN RPCs (§5.3 listLiveSessions + kill) pass `allowDuringReconcile` so they are not blocked
      // by the very guard reconciliation sets — otherwise reconciliation could never complete.
      throw new CliChatUnavailableError("cli-runner reconciling after restart");
    }
    const id = this.nextId++;
    const frame: RpcFrame = { t: "req", id, method, sessionKey, params };
    const timeoutMs = this.callTimeoutMs(method);
    return new Promise<T>((resolve, reject) => {
      // §3.4 per-call deadline. cli-runner may ACCEPT a frame and then never reply (a wedged
      // provider CLI). The socket stays open, so neither `routeFrame` nor `failAllInFlight` ever
      // settles this promise — without a timer it hangs forever, and for a chat turn that
      // permanently wedges the per-user turn-in-flight lock (#445). The timer rejects the call and
      // removes its pending entry; the late response (if any) is then dropped by `routeFrame`.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clear = () => {
        if (timer) clearTimeout(timer);
      };
      // #456 — re-arm the deadline (activity-aware reset). Clears the current timer and sets a fresh
      // one of the same duration. Called by resetActivityDeadline(sessionKey) when the manager
      // observes new transcript records, so an actively-producing turn never trips the deadline.
      const resetDeadline = () => {
        if (timeoutMs <= 0) return;
        clear();
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(
            new CliChatUnavailableError(`cli-runner ${method} timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
        timer.unref?.();
      };
      this.pending.set(id, {
        method,
        sessionKey,
        resolve: (r) => {
          clear();
          resolve(r as T);
        },
        reject: (err) => {
          clear();
          reject(err);
        },
        resetDeadline
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Already settled (response/close raced the timer) → nothing to do.
          if (!this.pending.delete(id)) return;
          reject(
            new CliChatUnavailableError(`cli-runner ${method} timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
        // Don't let a pending deadline keep the process alive (worker/api shutdown).
        timer.unref?.();
      }
      try {
        this.writeFrame(frame, method, id, sessionKey);
      } catch (err) {
        clear();
        this.pending.delete(id);
        reject(new CliChatUnavailableError("cli-runner socket write failed", { cause: err }));
      }
    });
  }

  private writeFrame(frame: RpcFrame, method: RpcMethod, id: number, sessionKey?: string): void {
    const buf = encodeFrame(frame);
    // §6.4: log only method/id/sessionKey/byte-length — NEVER the frame body.
    this.log.debug({ method, id, sessionKey, bytes: buf.length });
    const sock = this.socket;
    if (!sock) throw new Error("no socket");
    sock.write(buf);
  }

  // ─── connect / handshake / reconnect ─────────────────────────────────────────

  /**
   * Ensure the socket is connected AND the auth hello has completed. Multiple concurrent callers
   * share the same in-flight connect promise. On `ECONNREFUSED`/`ENOENT` retries with capped jittered
   * backoff (§3.5) until connected or the connection is closed by the caller.
   */
  async ensureConnected(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "closed") throw new CliChatUnavailableError("rpc connection closed");
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithBackoff().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectWithBackoff(): Promise<void> {
    // §3.1: realpath-check the socket resolves UNDER /run/jarv1s BEFORE any connect attempt (mirror of
    // the server bind check; defends a redirected socket path). This is a CONFIGURATION error, not a
    // transient connect failure — it can never become valid by retrying, so it propagates out of the
    // backoff loop and rejects `ensureConnected` (a retried-forever guard would hang the caller).
    await this.assertSocketUnderRunDir();

    let attempt = 0;
    for (;;) {
      if (this.closedByCaller) throw new CliChatUnavailableError("rpc connection closed");
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        attempt += 1;
        this.log.warn(`cli-runner connect attempt ${attempt} failed: ${describeError(err)}`);
        const delay = backoffDelay(attempt, this.reconnectMinMs, this.reconnectMaxMs);
        await sleep(delay);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    this.state = "connecting";
    this.recvBuf = Buffer.alloc(0);
    this.bootId = null;
    this.nextId = 1;

    const socket = await openSocket(this.socketPath);
    this.socket = socket;

    socket.on("error", (err) => this.onSocketClosed(err));
    socket.on("close", () => this.onSocketClosed());

    // §3.6: perform the mutual challenge-response hello BEFORE any RpcRequest. This both proves the
    // server holds the secret (so we never hand a token to an imposter peer) and proves we hold it.
    // The shared `performClientHello` (#1059, ./rpc-handshake.ts) owns the `data` stream during the
    // hello; the normal response router is attached ONLY after the handshake completes, so a
    // handshake frame is never misrouted into `routeFrame` (which would treat the hello-challenge as
    // a malformed response and drop the connection).
    this.state = "handshaking";
    await this.performHello(socket);

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.state = "ready";

    // Any bytes that arrived after the hello frame were returned as `leftover` by performHello and
    // stashed into recvBuf; drain them now that the normal router is attached (§3.2 — a response may
    // already be buffered).
    if (this.recvBuf.length > 0) this.drainRecvBuf();

    // §3.5 / §5.3: run reconciliation on every (re)connect before serving new turns.
    await this.runReconciliation();
  }

  /**
   * §3.1 client-side guard: refuse a socket path whose realpath escapes /run/jarv1s. `protected` so a
   * unit-test subclass can relax it to bind a temp socket (the guard itself is covered separately).
   */
  protected async assertSocketUnderRunDir(): Promise<void> {
    const allowed = resolvePath(SOCKET_ALLOWED_DIR);
    let resolved: string;
    try {
      resolved = await realpath(this.socketPath);
    } catch {
      // The socket may not exist yet (cli-runner not up). Fall back to a lexical resolve so a
      // redirected/escaping configured path is still rejected; a non-existent in-dir path proceeds
      // to connect (which will ECONNREFUSED/ENOENT and back off).
      resolved = resolvePath(this.socketPath);
    }
    if (resolved !== allowed && !resolved.startsWith(allowed + sep)) {
      throw new CliChatUnavailableError(
        `refusing cli-runner socket outside ${SOCKET_ALLOWED_DIR}: ${resolved}`
      );
    }
  }

  /**
   * §3.6 mutual challenge-response hello. Delegates to the shared `performClientHello` (#1059,
   * ./rpc-handshake.ts — extracted so this connection and `TerminalRpcClient` run the IDENTICAL
   * client-side hello instead of maintaining two copies of security-critical code). Any bytes that
   * arrived on the wire immediately after the hello-challenge frame (a response may already be
   * buffered directly behind it) are appended to `recvBuf` so `drainRecvBuf()` picks them up once
   * the normal frame router attaches.
   */
  private async performHello(socket: Socket): Promise<void> {
    this.log.debug({ method: "hello" });
    const { leftover } = await performClientHello(socket, this.rpcSecret);
    if (leftover.length > 0) this.recvBuf = Buffer.concat([this.recvBuf, leftover]);
  }

  // ─── inbound framing + id-matching ───────────────────────────────────────────

  /** Drain any frames already buffered in recvBuf (e.g. bytes the handshake reader stashed). */
  private drainRecvBuf(): void {
    this.onData(Buffer.alloc(0));
  }

  private onData(chunk: Buffer<ArrayBufferLike>): void {
    this.recvBuf = this.recvBuf.length === 0 ? chunk : Buffer.concat([this.recvBuf, chunk]);
    for (;;) {
      const decoded = decodeFrame(this.recvBuf);
      if (decoded.kind === "incomplete") return;
      if (decoded.kind === "oversize") {
        // §3.2/§3.7: a frame larger than MAX_FRAME_BYTES is malformed — the stream can no longer be
        // trusted to be aligned. Drop the connection; the close path reconnects + reconciles.
        this.log.warn(`cli-runner sent oversize frame (${decoded.declaredLength} bytes); closing`);
        this.dropConnection();
        return;
      }
      this.recvBuf = this.recvBuf.subarray(decoded.consumed);
      let frame: RpcFrame;
      try {
        frame = JSON.parse(decoded.body.toString("utf8")) as RpcFrame;
      } catch {
        // §3.7: a body that is not valid JSON is a malformed frame — close + reconnect.
        this.log.warn("cli-runner sent a non-JSON frame; closing");
        this.dropConnection();
        return;
      }
      this.routeFrame(frame);
    }
  }

  private routeFrame(frame: RpcFrame): void {
    // #1554 Decision 2: unsolicited server-initiated push, not a request/response. Terminal pushes
    // (`terminalData`/`terminalExit`) ride `TerminalRpcClient`'s own separate connection (this
    // connection never sees them, per that file's header comment) — the only push channel this
    // connection routes is `sessionReaped`. No `id` to settle and no bootId-driven reconciliation
    // implication, so this returns before the ok/err-only check below.
    if (frame.t === "push") {
      if (frame.channel === "sessionReaped") {
        this.onSessionReaped?.(frame.sessionKey, frame.reapReason);
      }
      return;
    }
    if (frame.t !== "ok" && frame.t !== "err") {
      // §3.7: an unexpected discriminant on the response stream is a malformed frame — close.
      this.log.warn("cli-runner sent an unexpected frame discriminant; closing");
      this.dropConnection();
      return;
    }
    // Deliver THIS frame's response to its caller FIRST — the response that REVEALS a new bootId is a
    // legitimate, completed reply to its own request and must not be swept into failAllInFlight (§5.6).
    const pending = this.pending.get(frame.id);
    if (pending) {
      this.pending.delete(frame.id);
      // §6.4: log only {method,id,sessionKey,bytes}; never result/error.message-with-body.
      this.log.debug({ method: pending.method, id: frame.id, sessionKey: pending.sessionKey });
      if (frame.t === "ok") {
        pending.resolve((frame as RpcOk).result);
      } else {
        const err = (frame as RpcErr).error;
        pending.reject(mapRpcError(err.code, err.message));
      }
    }
    // A response for an id we no longer track (already failed on a prior restart) still carries a
    // bootId — observe it below regardless.

    // §5.6: every ok/err carries the server bootId. Detect a silent fast restart AFTER delivering the
    // current reply; this fails any OTHER still-in-flight calls and runs reconciliation.
    this.observeBootId(frame.bootId);
  }

  /** §5.6: record the first bootId; a differing bootId is a silent restart → reconcile. */
  private observeBootId(bootId: string): void {
    if (this.bootId === null) {
      this.bootId = bootId;
      return;
    }
    if (this.bootId === bootId) return;
    // Silent fast restart: fail all in-flight calls, block new calls, run reconciliation.
    this.log.warn("cli-runner bootId changed (silent restart); reconciling");
    this.bootId = bootId;
    this.failAllInFlight(new CliChatUnavailableError("cli-runner restarted (bootId changed)"));
    void this.runReconciliation();
  }

  // ─── reconnect / reconciliation ──────────────────────────────────────────────

  private onSocketClosed(err?: unknown): void {
    if (this.state === "closed" || this.closedByCaller) return;
    if (err) this.log.warn(`cli-runner socket error: ${describeError(err)}`);
    this.dropConnection();
  }

  /** Tear down the current socket, fail in-flight calls, and reset to idle so the next call reconnects. */
  private dropConnection(): void {
    if (this.socket) {
      this.socket.removeAllListeners("data");
      this.socket.destroy();
      this.socket = null;
    }
    this.recvBuf = Buffer.alloc(0);
    this.bootId = null;
    this.reconciling = false;
    this.state = this.closedByCaller ? "closed" : "idle";
    // §3.5(1): fail all in-flight requests with `unavailable` — HTTP retry is the recovery path.
    this.failAllInFlight(new CliChatUnavailableError("cli-runner connection lost"));
  }

  private failAllInFlight(err: Error): void {
    const inflight = [...this.pending.values()];
    this.pending.clear();
    for (const call of inflight) call.reject(err);
  }

  /**
   * Run the ONE reconciliation hook (§5.3) the manager wired. While it runs, `reconciling` blocks new
   * calls (they 503 + retry). Errors are logged and swallowed — a failed reconciliation must not wedge
   * the connection (the next reconnect/bootId-change retries it).
   */
  private async runReconciliation(): Promise<void> {
    if (!this.onReconcile) return;
    this.reconciling = true;
    // The driver handed to the hook issues its RPCs with `allowDuringReconcile = true`, so the
    // §5.3 reconciliation flow (listLiveSessions → kill orphans) can run over the SAME connection
    // while `reconciling` blocks every NORMAL turn. Without this the routine would deadlock against
    // its own guard (it could never gather liveKeys or reap orphaned mux sessions).
    const driver: RpcReconcileDriver = {
      listLiveSessions: () =>
        this.call<RpcListLiveSessionsResult>("listLiveSessions", undefined, {}, true),
      kill: (sessionKey: string, opts: RpcKillParams = {}) =>
        this.call<RpcKillResult>("kill", sessionKey, opts, true)
    };
    try {
      await this.onReconcile(driver);
    } catch (err) {
      this.log.warn(`cli-runner reconciliation failed: ${describeError(err)}`);
    } finally {
      this.reconciling = false;
    }
  }
}

/**
 * The per-`sessionKey` engine the factory hands to `ChatSessionManager`. Implements `CliChatEngine`
 * by marshalling each method onto the shared `RpcConnection`. `provider` is known at construction
 * (the factory passes it) so it is never an RPC (§4.0).
 */
export class ChatEngineRpcClient implements CliChatEngine {
  constructor(
    public readonly provider: ProviderKind,
    private readonly sessionKey: string,
    private readonly conn: RpcConnection,
    // Defensive-only default (the value is always threaded from the NOT NULL DB column in prod);
    // the one-shot-by-default flip lives at the DB + repository write-path layer (#1238/#1239).
    private readonly executionMode: AiProviderExecutionMode = "interactive",
    /**
     * #1554 — live read of the three persistent-runtime settings, called on EVERY launch so the
     * cli-runner root gets current values (the plan's live-reload channel for this topology).
     * Absent ⇒ the launch carries no persistent fields and the runner keeps its boot bootstrap.
     */
    private readonly readPersistentConfig?: () => Promise<PersistentRuntimeLaunchConfig>,
    /** B4: forwarded to `RpcLaunchParams.needsStructuredOutput`. See its doc comment. */
    private readonly needsStructuredOutput = false
  ) {}

  /**
   * §4.1.0a: serialize ONLY personaText + replayBatch + mcpToken + mcpServerUrl + provider into
   * RpcLaunchParams and DROP neutralDir + personaPath (the api has no CLI-data mount; those paths are
   * meaningless cross-container). Returns the post-drain offset (§4.1.2).
   */
  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    // #1554: fail-closed — a settings read that throws degrades this launch to the bounded-fallback
    // engine (persistent OFF), never fails the turn. Same posture as the in-process root's readers.
    const persistent = this.readPersistentConfig
      ? await this.readPersistentConfig().catch(
          (): PersistentRuntimeLaunchConfig => ({
            enabled: false,
            poolCap: 4,
            idleReapMinutes: 30
          })
        )
      : undefined;
    const params: RpcLaunchParams = {
      provider: this.provider,
      executionMode: this.executionMode,
      needsStructuredOutput: this.needsStructuredOutput,
      personaText: opts.personaText ?? "",
      ...(opts.mcpToken !== undefined ? { mcpToken: opts.mcpToken } : {}),
      ...(opts.mcpServerUrl !== undefined ? { mcpServerUrl: opts.mcpServerUrl } : {}),
      ...(opts.replayBatch !== undefined ? { replayBatch: opts.replayBatch } : {}),
      ...(opts.replayBatch ? { replayAttemptId: opts.replayAttemptId ?? randomUUID() } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(persistent
        ? {
            persistentRuntimeEnabled: persistent.enabled,
            persistentPoolCap: persistent.poolCap,
            persistentIdleReapMinutes: persistent.idleReapMinutes
          }
        : {})
    };
    const result = await this.conn.launch(this.sessionKey, params);
    return { offset: result.offset };
  }

  async submit(text: string): Promise<void> {
    await this.conn.submit(this.sessionKey, { attemptId: randomUUID(), text });
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    const result = await this.conn.readNew(this.sessionKey, { afterOffset });
    return { records: result.records, offset: result.offset, complete: result.complete };
  }

  async isAlive(): Promise<boolean> {
    const result = await this.conn.isAlive(this.sessionKey);
    return result.alive;
  }

  async kill(opts?: EngineKillOpts): Promise<void> {
    await this.conn.kill(this.sessionKey, opts);
  }

  /**
   * #744 — purge this private session's transcripts server-side before kill removes its exact
   * identity marker. Rejects if the RPC fails, so kill preserves the marker for the boot sweep.
   */
  async purgeTranscripts(): Promise<void> {
    await this.conn.purgeTranscripts(this.sessionKey);
  }

  async interrupt(): Promise<void> {
    await this.conn.interrupt(this.sessionKey);
  }

  /** #456 — forward the activity signal to the shared connection's deadline-reset for this session. */
  resetActivityDeadline(): void {
    this.conn.resetActivityDeadline(this.sessionKey);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
// hmacHex/constantTimeHexEqual/isHelloChallenge moved into ./rpc-handshake.ts (#1059 extraction) —
// they now live with performClientHello, their only caller.

/** §3.5 backoff: 250ms → 2s, exponential with full jitter. */
function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** (attempt - 1));
  return Math.floor(minMs + Math.random() * Math.max(0, ceiling - minMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const onError = (err: Error): void => {
      socket.off("connect", onConnect);
      reject(err);
    };
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
