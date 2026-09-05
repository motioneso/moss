import type { ProviderLoginScope } from "@moss/shared";
/**
 * FROZEN RPC WIRE CONTRACT — the api ⇄ cli-runner boundary for in-container CLI chat (#342).
 *
 * This is the single home of every wire type that crosses the private Unix-domain socket
 * (spec: docs/superpowers/specs/2026-06-20-cli-runner-rpc-contract.md §10 "WIRE-TYPE HOME").
 * Lane A authors it FIRST; Lanes B (cli-runner server) and D (tokens/state/onboarding) import it
 * READ-ONLY. No other file re-declares any of these shapes.
 *
 * `TranscriptRecord` / `ChatRecordKind` continue to live in `./types` (reused verbatim, §4.0) and
 * are re-exported here for convenience — NOT re-declared. `ProviderKind` similarly comes from
 * `@moss/ai` via `./types`.
 *
 * Framing (§3.2): each message is a 4-byte big-endian uint32 length prefix followed by exactly that
 * many bytes of UTF-8 JSON. `MAX_FRAME_BYTES` bounds an individual frame; an over-size frame is a
 * malformed frame and the receiver closes the connection (§3.7).
 */

import type { AiCliModelListResult, AiProviderExecutionMode } from "@moss/shared";

import type { TranscriptRecord, ChatRecordKind } from "./types.js";
import type { ReapReason } from "./provider-runtime.js";

// Re-export the verbatim transcript shapes so Lanes B/D can import everything from one module
// without reaching back into types.ts. These are NOT re-declared here (§4.0 / §10).
export type { TranscriptRecord, ChatRecordKind };
// #1554: re-export so cli-runner (which only sees this package through the "@moss/chat/live"
// barrel, never a relative path into provider-runtime.ts) can type its own sessionReaped
// listener/broadcast signatures against the same ReapReason used in RpcPushSessionReaped.
export type { ReapReason };

/**
 * Provider selector mirrored across the wire. This is the SAME value set as `ProviderKind`
 * from `@moss/ai` ("anthropic" | "openai-compatible" | "google"); spelled out here as a literal
 * union so the wire contract does not pull a cross-package import into every consumer. Re-exported
 * from `./types` as the canonical `ProviderKind` for engine code.
 */
export type RpcProviderKind = "anthropic" | "openai-compatible" | "google";

// ---------------------------------------------------------------------------------------------
// §3.2 Framing constants + length-prefix helpers
// ---------------------------------------------------------------------------------------------

/**
 * Maximum size (bytes) of a single length-prefixed frame body (§3.2). A frame whose declared length
 * exceeds this is malformed: the receiver closes the connection (it cannot trust stream alignment).
 * 16 MiB.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Width of the big-endian uint32 length prefix that precedes every frame body (§3.2). */
export const FRAME_HEADER_BYTES = 4;

/**
 * Encode a JSON-serializable frame to a single length-prefixed buffer (§3.2): a 4-byte big-endian
 * uint32 length prefix followed by the UTF-8 JSON body. Throws if the encoded body exceeds
 * `MAX_FRAME_BYTES` (the caller must not emit an un-framable frame; on the read side an over-size
 * declared length closes the connection instead).
 */
export function encodeFrame(frame: RpcFrame | RpcHandshakeFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`rpc frame too large: ${body.length} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Result of attempting to decode one frame from the head of a receive buffer (§3.2). */
export type FrameDecodeResult =
  | {
      /** A complete frame body was available. */
      readonly kind: "frame";
      /** The UTF-8 JSON body bytes (length === the decoded prefix). Caller JSON-parses it. */
      readonly body: Buffer;
      /** Bytes consumed from the front of the input buffer (header + body). */
      readonly consumed: number;
    }
  | {
      /** Not enough bytes buffered yet to read the prefix and/or the full body. Wait for more. */
      readonly kind: "incomplete";
    }
  | {
      /** Declared length exceeds MAX_FRAME_BYTES — malformed frame; the receiver MUST close (§3.7). */
      readonly kind: "oversize";
      /** The declared length that exceeded the cap (for a redacted log line, never the body). */
      readonly declaredLength: number;
    };

/**
 * Decode a single frame from the front of `buf` (§3.2). Does NOT mutate `buf`; the caller slices off
 * `consumed` bytes on a "frame" result. Returns "incomplete" until both the 4-byte prefix and the
 * full declared body are present, and "oversize" (caller closes the connection) when the declared
 * length exceeds `MAX_FRAME_BYTES`.
 */
export function decodeFrame(buf: Buffer): FrameDecodeResult {
  if (buf.length < FRAME_HEADER_BYTES) return { kind: "incomplete" };
  const declaredLength = buf.readUInt32BE(0);
  if (declaredLength > MAX_FRAME_BYTES) return { kind: "oversize", declaredLength };
  const total = FRAME_HEADER_BYTES + declaredLength;
  if (buf.length < total) return { kind: "incomplete" };
  return {
    kind: "frame",
    body: buf.subarray(FRAME_HEADER_BYTES, total),
    consumed: total
  };
}

// ---------------------------------------------------------------------------------------------
// §3.6 Connection auth hello — mutual challenge-response (the secret is NEVER sent on the wire)
// ---------------------------------------------------------------------------------------------

/** Client → server, FIRST frame (§3.6). */
export interface RpcHello {
  readonly t: "hello";
  /** Random 32-byte hex nonce chosen by the client. */
  readonly clientNonce: string;
}

/** Server → client: proves it holds the secret AND challenges the client (§3.6). */
export interface RpcHelloChallenge {
  readonly t: "hello-challenge";
  /** HMAC_SHA256(secret, "S" + clientNonce) — hex. The client verifies this BEFORE replying. */
  readonly serverProof: string;
  /** Random 32-byte hex nonce chosen by the server. */
  readonly serverNonce: string;
}

/** Client → server: proves it holds the secret (§3.6). */
export interface RpcHelloResponse {
  readonly t: "hello-response";
  /** HMAC_SHA256(secret, "C" + serverNonce) — hex. The server constant-time compares this. */
  readonly clientProof: string;
}

/** The three handshake frames, exchanged (in order) before any `RpcRequest` (§3.6). */
export type RpcHandshakeFrame = RpcHello | RpcHelloChallenge | RpcHelloResponse;

/**
 * Domain-separation tags for the two HMAC proofs (§3.6). Distinct tags prevent a reflected proof
 * (the server's `serverProof` can never be replayed as a valid `clientProof` and vice-versa).
 */
export const HELLO_PROOF_TAG_SERVER = "S";
export const HELLO_PROOF_TAG_CLIENT = "C";

// ---------------------------------------------------------------------------------------------
// §3.4 Request / response / error envelope
// ---------------------------------------------------------------------------------------------

export type RpcMethod =
  | "launch"
  | "launchSourceGeneration"
  | "submit"
  | "cancelSubmit"
  | "readNew"
  // Structured one-shot calls (email extraction and other scoped structured callers, review B4
  // follow-up): "launch" is reused for the structured launch (see RpcLaunchParams.schema) because
  // its result shape already matches; submit/read need their own methods because their param/result
  // shapes differ from the ordinary chat submit/readNew (no attemptId, no TranscriptRecord[]).
  | "submitStructured"
  | "readStructured"
  | "isAlive"
  | "interrupt"
  | "purgeTranscripts" // per-session (sessionKey required) — #744 private-chat transcript purge over RPC
  | "kill" // per-session (sessionKey required); private cleanup purges before kill
  | "listLiveSessions" // non-session (reconciliation, §4.6)
  | "probeProvider" // non-session (onboarding, §4.8)
  | "installProvider" // non-session (on-demand installer, install-contract §A.2 — ADDITIVE)
  | "beginLogin" // non-session (login presentation, login-contract §L.2 — ADDITIVE)
  | "pollLogin" // non-session (login presentation, login-contract §L.2 — ADDITIVE)
  | "submitLoginToken" // non-session (login presentation, login-contract §L.2 — ADDITIVE)
  | "cancelLogin" // non-session (login presentation, login-contract §L.2 — ADDITIVE)
  | "listProviderModels" // non-session (#2208 live model list from the provider's vendor — ADDITIVE)
  // #1059 owner terminal — additive, never used by the chat runtime
  | "openTerminal"
  | "writeTerminal"
  | "resizeTerminal"
  | "killTerminal";

export type RpcErrorCode =
  | "unavailable" // engine could not launch / multiplexer down / NOT_LAUNCHED → CliChatUnavailableError (retryable HTTP 503)
  | "delivery_unknown" // Enter was sent but exact ACK was not observed; never auto-retry
  | "not_launched" // submit/readNew/isAlive called before a successful launch — maps to RETRYABLE 503 (§4.7)
  | "bad_request" // semantically-invalid params (bad offset, missing sessionKey) — does NOT close the connection
  | "internal"; // unexpected server-side failure (already redacted)

/** Client → server. One per RPC call. `id` is unique per connection (§3.4). */
export interface RpcRequest {
  readonly t: "req";
  /** client-assigned, monotonic per connection, 1..2^53-1 */
  readonly id: number;
  readonly method: RpcMethod;
  /**
   * = actorUserId; routes to the per-user engine. OPTIONAL: omitted by the non-session methods
   * listLiveSessions and probeProvider. REQUIRED + non-empty for every other method
   * (launch/submit/readNew/isAlive/kill). A missing or empty sessionKey on a session method ⇒
   * RpcErr bad_request (§3.7), not a close.
   */
  readonly sessionKey?: string;
  /** method-specific; shapes in §4 */
  readonly params: unknown;
}

/** Server → client. Success (§3.4). */
export interface RpcOk {
  readonly t: "ok";
  /** echoes the request id */
  readonly id: number;
  /** server boot uuid (§5.6); same for every response from one cli-runner process */
  readonly bootId: string;
  /** method-specific; shapes in §4 */
  readonly result: unknown;
}

/** Server → client. Failure (§3.4). */
export interface RpcErr {
  readonly t: "err";
  /** echoes the request id */
  readonly id: number;
  /** server boot uuid (§5.6) — present on errors too, so a restart is detectable mid-failure */
  readonly bootId: string;
  readonly error: RpcError;
}

export interface RpcError {
  /** Stable machine code; the client maps it back to a typed JS error (§4.7). */
  readonly code: RpcErrorCode;
  /** Human-readable, ALREADY redacted server-side via redactSecrets (§6.4). Safe to log. */
  readonly message: string;
}

// #1059 server-initiated output frame. First non-request/response member of RpcFrame.
// Carries no `id` (unsolicited); routed by `channel` (+ `terminalId` for terminal channels),
// base64 to stay JSON-safe. #1554: discriminated union on `channel` (was a single interface with
// optional fields, which let a caller construct an ill-typed "terminalData" push carrying
// reapReason, or a "sessionReaped" push missing sessionKey).
export interface RpcPushTerminalData {
  readonly t: "push";
  readonly bootId: string;
  readonly channel: "terminalData";
  readonly terminalId: string;
  readonly dataB64: string;
}
export interface RpcPushTerminalExit {
  readonly t: "push";
  readonly bootId: string;
  readonly channel: "terminalExit";
  readonly terminalId: string;
  readonly exitCode: number;
}
export interface RpcPushSessionReaped {
  readonly t: "push";
  readonly bootId: string;
  readonly channel: "sessionReaped";
  readonly sessionKey: string;
  readonly reapReason: ReapReason;
}
export type RpcPush = RpcPushTerminalData | RpcPushTerminalExit | RpcPushSessionReaped;

/** The request/response/push envelope shapes (post-handshake) (§3.4). */
export type RpcFrame = RpcRequest | RpcOk | RpcErr | RpcPush; // #1059: was RpcRequest | RpcOk | RpcErr

// ---------------------------------------------------------------------------------------------
// §4 Method params / results
// ---------------------------------------------------------------------------------------------

/** params for method "launch" (§4.1.1a). */
export interface RpcLaunchParams {
  /** Selects the CLI + transcript parser. Mirrors CliChatEngine.provider. */
  readonly provider: RpcProviderKind;
  readonly executionMode?: AiProviderExecutionMode;
  /** #1350/B4: set only by a structured caller. See `ChatEngineSelectionOpts.needsStructuredOutput`
   *  in engine-selection.ts — this carries the same call-boundary signal across the socket so the
   *  cli-runner root can't drift from the in-process root on which calls keep the bounded print
   *  engine regardless of the persistent-runtime flag. */
  readonly needsStructuredOutput?: boolean;
  /**
   * Rendered persona CONTENT (NOT a path). cli-runner writes it to the persona file under the
   * server-derived neutralDir, then passes that path to the CLI (e.g. --append-system-prompt-file).
   * This is the full text produced by the api's resolveChatPersona().
   */
  readonly personaText: string;
  /**
   * Opaque per-session MCP bearer token (jst_<uuid>), minted + owned by the API
   * (session-tokens.ts). Crosses to cli-runner ONLY here, in this socket payload. NEVER via env,
   * argv, or a launch line. cli-runner injects it per-provider (§6.2). Absent ⇒ launch the CLI with
   * NO MCP server (tools disabled), exactly as today when mcpToken is falsy.
   */
  readonly mcpToken?: string;
  /** MCP gateway base URL (api-side, reachable from cli-runner over the jarv1s network). */
  readonly mcpServerUrl?: string;
  /**
   * The prior-conversation replay batch as ONE string (memory seed + rolling summary + recent
   * turns), already assembled + injection-neutralized by the api. Absent or "" ⇒ no replay (fresh
   * conversation). When present, cli-runner submits it after the CLI boots and drains the transcript
   * so the first real turn starts from a clean offset.
   */
  readonly replayBatch?: string;
  /** Required exactly when replayBatch is non-empty; stable across transport retry. */
  readonly replayAttemptId?: string;
  /**
   * #367: the resolved provider model id from the active chat model row. For the `"default"`
   * sentinel (the auto-registered default) cli-runner OMITS `--model` so the CLI rides its own
   * interactive/account model — the primary path. For a CONCRETE id (an explicit settings override)
   * it passes `--model <id>`; absent ⇒ also omit.
   */
  readonly model?: string;
  /**
   * #1554 — `chat.persistent_runtime.enabled`, read LIVE by the api on every launch and carried
   * here. This is the plan's live-reload mechanism for the RPC/containerized topology ("Settings &
   * flags": values reach the cli-runner root inside RPC launch params, never via child env), so an
   * operator flipping the rollout flag drains to the bounded-fallback engine without a deploy.
   * Absent ⇒ cli-runner keeps its last known value (boot env bootstrap on the first launch).
   */
  readonly persistentRuntimeEnabled?: boolean;
  /** #1554 — `chat.persistent_pool_cap`, same live-read-per-launch contract as
   *  {@link persistentRuntimeEnabled}. Non-positive/garbage values are ignored server-side. */
  readonly persistentPoolCap?: number;
  /** #1554 — `chat.persistent_idle_reap_minutes`, same live-read-per-launch contract; the
   *  cli-runner's idle-reap timer re-reads it on every tick. */
  readonly persistentIdleReapMinutes?: number;
  /**
   * Review B4 follow-up — present only for a structured one-shot call (e.g. email extraction via
   * `CliStructuredAdapter`). Mirrors `CliStructuredEngine.launchStructured`'s `schema` param
   * (cli-structured-adapter.ts). When present, cli-runner calls the built engine's
   * `launchStructured(...)` instead of `launch(...)`; `RpcLaunchResult` already matches that
   * method's `{offset}` return shape, so "launch" is reused rather than adding a new method.
   */
  readonly schema?: Record<string, unknown>;
}

/** Server-owned source-generation launch. Deliberately separate from `launch`: older runners
 * reject this method instead of silently dropping a safety policy field. */
export interface RpcSourceGenerationLaunchParams {
  readonly scope: ProviderLoginScope;
  readonly provider: RpcProviderKind;
  /** Concrete provider model; the `default` sentinel is not accepted. */
  readonly model: string;
  readonly personaText: string;
  readonly schema: Record<string, unknown>;
}

/**
 * #1554 — the three persistent-runtime settings the api reads live (from `app.instance_settings`)
 * and ships to the cli-runner inside {@link RpcLaunchParams}. The api owns the DB; the cli-runner
 * has no DB access, so this launch-param channel is the ONLY way these settings reach it.
 */
export interface PersistentRuntimeLaunchConfig {
  readonly enabled: boolean;
  readonly poolCap: number;
  readonly idleReapMinutes: number;
}

/**
 * result for method "launch" (§4.1.2). Carries the post-drain transcript offset: after the server
 * launches the CLI and (if replayBatch present) submits+drains it, `offset` is the transcript length
 * consumed so far (jsonl.length / UTF-16 code units, §3.3). The api seeds session.transcriptOffset
 * from this so the FIRST real readNew does not re-read the replay as the reply.
 */
export interface RpcLaunchResult {
  readonly offset: number;
}

/** params for method "submit" (§4.2). */
export interface RpcSubmitParams {
  readonly attemptId: string;
  readonly text: string;
}
/** result for method "submit" (§4.2). */
export interface RpcSubmitResult {
  readonly ok: true;
}

export interface RpcCancelSubmitParams {
  readonly attemptId: string;
}
export interface RpcCancelSubmitResult {
  readonly ok: true;
}

/** params for method "isAlive" (§4.3) — empty. */
export type RpcIsAliveParams = Record<string, never>;
/** result for method "isAlive" (§4.3). */
export interface RpcIsAliveResult {
  readonly alive: boolean;
}

/** params for method "readNew" (§4.4). */
export interface RpcReadNewParams {
  /**
   * Offset into the JSONL transcript as a JS string (UTF-16 code units, §3.3); non-negative integer
   * ≤ Number.MAX_SAFE_INTEGER.
   */
  readonly afterOffset: number;
}
/** result for method "readNew" (§4.4). */
export interface RpcReadNewResult {
  /** EXISTING TranscriptRecord shape, reused verbatim (types.ts; §4.0). */
  readonly records: TranscriptRecord[];
  /** New offset = jsonl.length (UTF-16 code units, §3.3). Pass back as afterOffset next poll. */
  readonly offset: number;
  /** True once the engine detects end-of-turn for the provider (transcript-reader completion). */
  readonly complete: boolean;
}

/**
 * Review B4 follow-up — params/result for method "submitStructured". Mirrors
 * `CliStructuredEngine.submitStructured` (cli-structured-adapter.ts): a plain text turn, no
 * attemptId (a structured session is one caller, one turn at a time; the ordinary submit's
 * idempotency ledger does not apply).
 */
export interface RpcSubmitStructuredParams {
  readonly text: string;
}
export interface RpcSubmitStructuredResult {
  readonly ok: true;
}

/**
 * Review B4 follow-up — params/result for method "readStructured". Mirrors
 * `CliStructuredEngine.readStructured` (cli-structured-adapter.ts): unlike readNew, this returns
 * raw accumulated text (not TranscriptRecord[]).
 */
export interface RpcReadStructuredParams {
  readonly afterOffset: number;
}
export interface RpcReadStructuredResult {
  readonly text?: string;
  readonly offset: number;
  readonly complete: boolean;
}

/** params for method "kill" (§4.5). Failed private purge preserves its exact retry marker. */
export interface RpcKillParams {
  readonly preserveNeutralDir?: boolean;
}
/** result for method "kill" (§4.5). */
export interface RpcKillResult {
  readonly ok: true;
}

/**
 * params for method "purgeTranscripts" (#744) — empty; sessionKey rides the envelope like kill.
 * Private (incognito) chat purge. On the split RPC topology the api cannot see the cli-runner's
 * home dir, so the purge MUST run server-side; this verb is the authoritative success signal the
 * manager gates its bookkeeping-row delete on (a false success would strand a private transcript).
 */
export type RpcPurgeTranscriptsParams = Record<string, never>;
/** result for method "purgeTranscripts" (#744). */
export interface RpcPurgeTranscriptsResult {
  readonly ok: true;
}

/** params for method "interrupt" — empty. */
export type RpcInterruptParams = Record<string, never>;
/** result for method "interrupt". */
export interface RpcInterruptResult {
  readonly ok: true;
}

/** params for method "listLiveSessions" (§4.6) — empty (instance-wide query, no sessionKey). */
export type RpcListLiveSessionsParams = Record<string, never>;
/** result for method "listLiveSessions" (§4.6). */
export interface RpcListLiveSessionsResult {
  /** Every sessionKey for which cli-runner currently holds a LIVE jarv1s-live-* mux session. */
  readonly sessionKeys: string[];
}

/** params for method "probeProvider" (§4.8) — instance-wide query, no sessionKey. */
export interface RpcProbeProviderParams {
  readonly provider: RpcProviderKind;
}
/** result for method "probeProvider" (§4.8). */
export interface RpcProbeProviderResult {
  /** EXISTING OnboardingProviderCheckResponse status set (onboarding-api.ts), reused verbatim. */
  readonly status: "ready" | "needs_login" | "not_installed" | "multiplexer_unavailable" | "error";
  readonly message?: string;
}

/**
 * params for method "listProviderModels" (#2208) — instance-wide query, no sessionKey. The runner
 * reads the provider's stored login credential from the cli-auth volume and asks the vendor for
 * its live model list; ONLY model ids cross the socket (never the credential, never in `message`).
 */
export interface RpcListProviderModelsParams {
  readonly provider: RpcProviderKind;
}
/** result for method "listProviderModels" (#2208) — the shared `AiCliModelListResult` verbatim. */
export type RpcListProviderModelsResult = AiCliModelListResult;

// #1059 terminal method params/results (interface-pair pattern, mirrors RpcSubmit*). Additive
// only — no existing method's request/response shape changes.
/** params for method "openTerminal": requested initial PTY size. */
export interface RpcOpenTerminalParams {
  readonly cols: number;
  readonly rows: number;
}
/** result for method "openTerminal": the id later frames route on. */
export interface RpcOpenTerminalResult {
  readonly terminalId: string;
}
/** params for method "writeTerminal": raw input bytes, base64 to stay JSON-safe. */
export interface RpcWriteTerminalParams {
  readonly terminalId: string;
  readonly dataB64: string;
}
/** params for method "resizeTerminal": PTY resize on client viewport change. */
export interface RpcResizeTerminalParams {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}
/** params for method "killTerminal": terminate the PTY + its process tree. */
export interface RpcKillTerminalParams {
  readonly terminalId: string;
}
