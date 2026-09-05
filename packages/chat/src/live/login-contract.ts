/**
 * §L login-contract — the ADDITIVE Phase-3 login-presentation wire surface.
 *
 * Home of the four login RPC verbs' params/result/status shapes AND the per-provider
 * login-adapter TYPE (login-contract §L.1.1/§L.2.1). Layered strictly ON TOP of the
 * FROZEN base RPC contract (`rpc-contract.ts`) + the FROZEN install addendum
 * (`install-contract.ts`): it imports `RpcProviderKind` read-only and re-declares NO
 * base/install wire type (§L.0). The only additive base edits are the four login
 * literals appended to `RpcMethod` in `rpc-contract.ts` (§L.0/§L.2).
 *
 * The CONCRETE login-adapter VALUES + the `extractSurface` parsers live SERVER-SIDE in
 * the cli-runner package (`packages/cli-runner/src/login-adapters.ts`) — they are the
 * auth-flow allowlist and must never ship to the browser bundle (mirrors how the install
 * catalog's concrete values live in `cli-runner/src/catalog.ts`). This file holds only
 * the TYPES both sides share.
 *
 * Grounded-on: login-contract spec FROZEN v1, install-contract FROZEN v2/R6, base FROZEN v2.
 */

import type { ProviderLoginScope } from "@moss/shared";

import type { RpcProviderKind } from "./rpc-contract.js";

// ---------------------------------------------------------------------------
// §L.1.1 — per-provider login-adapter TYPE (the auth-flow allowlist shape)
// ---------------------------------------------------------------------------

/** How the provider's login completes once the user acts in the browser (§L.1.1). */
export type LoginMode =
  /** The CLI auto-detects completion (it polls its own backend); the api just re-probes. */
  | "poll"
  /** The CLI prints a URL, the browser yields a code, the user pastes it back (submitLoginToken). */
  | "paste";

/**
 * The strict, allowlisted surface the server may forward to the api/UI from the captured
 * login pane (§L.1.1/§L.6.2). ONLY these fields ever cross the socket — never raw stdout /
 * capture-pane. Both are public authorization material (a URL to open, a short user/device
 * code to display), NOT a bearer token; useless without the user completing the browser
 * auth with their own credentials. The api MUST NOT log either (§L.6.2 MED-1).
 */
export interface LoginSurface {
  /** The authorization URL to open. https: + host+path-allowlisted per provider (§L.6.2). */
  readonly authorizationUrl?: string;
  /** A short device/pairing code to display (tight `userCodePattern`, §L.6.2). NOT a secret. */
  readonly userCode?: string;
}

/** A single allowlisted authorize-URL pattern: scheme is always https, host + path-prefix matched (§L.6.2). */
export interface LoginAuthUrlPattern {
  /** Host pattern, e.g. "claude.ai" or "*.anthropic.com". */
  readonly host: string;
  /** Required path prefix, e.g. "/oauth". MUST NOT be "/" or empty (§L.1.3 — host-only is too broad). */
  readonly pathPrefix: string;
}

/**
 * The per-provider login adapter (frozen SHAPE; concrete values are committed server-side
 * in `cli-runner/src/login-adapters.ts`, §L.1.2). agy has NO adapter while blocked (§L.9).
 */
export interface LoginAdapter {
  readonly provider: RpcProviderKind;
  /**
   * argv to START the login flow in the captured login tmux session (execFile-style, NOT a
   * shell string — same discipline as the rest of cli-runner). NEVER carries a token/secret
   * (login produces the cred; it does not consume one as argv). `loginArgv[0]` MUST equal the
   * provider's catalog `binary` (§L.1.3).
   */
  readonly loginArgv: readonly string[];
  /** Whether completion is poll-detected or needs a pasted code (§L.2). */
  readonly mode: LoginMode;
  /**
   * Extract ONLY the allowlisted {@link LoginSurface} from a captured-pane snapshot — a PURE
   * function. MUST return at most `{ authorizationUrl, userCode }` and NEVER echo raw
   * input/output. Applies the §L.6.2 https + host+path allowlist to `authorizationUrl` and
   * `userCodePattern` to `userCode`; a value failing the guard is DROPPED. The login SERVICE
   * additionally (a) never calls this to surface a userCode AFTER a submitLoginToken (§L.2.3),
   * and (b) drops any value byte-equal to the in-flight pasted token + runs `redactExact`
   * (§L.6.2/§L.6.3).
   */
  readonly extractSurface: (paneSnapshot: string) => LoginSurface;
  /** Per-provider https host+path allowlist for `authorizationUrl` (§L.6.2). */
  readonly authUrlAllowlist: readonly LoginAuthUrlPattern[];
  /** Tight regex the displayed device/pairing code MUST match, else it is dropped (§L.6.2). */
  readonly userCodePattern: RegExp;
  /**
   * (#363, token-based providers only) Tight regex matching the long-lived credential the login
   * CLI PRINTS on success (e.g. claude `setup-token` → `sk-ant-oat…`). When present, the login
   * service captures the match after the paste and persists it via the provider-token-store; the
   * captured value is a SECRET (added to `redactExact`, never surfaced). Absent ⇒ the provider
   * persists its own on-disk credential at login (codex/gemini) and no capture happens.
   */
  readonly tokenCapturePattern?: RegExp;
}

/**
 * The login-adapter registry TYPE (the concrete value lives server-side, §L.1.2). A provider
 * absent here is NOT login-supported — `beginLogin` for it returns the catalog/adapter-blocked
 * `bad_request` (§L.2.4). Install-support and login-support are SEPARATE axes (§L.9.2).
 */
export type LoginAdapterRegistry = Readonly<Partial<Record<RpcProviderKind, LoginAdapter>>>;

// ---------------------------------------------------------------------------
// §L.2.1 — login RPC wire types (additive; reuse the §3.4 envelope)
// ---------------------------------------------------------------------------

/** The status a login FLOW reports (§L.2.1) — NOT a persisted lifecycle state. */
export type LoginFlowStatus =
  /** Awaiting the user to authorize in the browser; surface carries the URL/code to display. */
  | "awaiting_authorization"
  /** (paste mode) Awaiting the user to paste the code back via submitLoginToken. */
  | "awaiting_token"
  /** Login completed AND the runtime smoke passed → the provider is authenticated (§L.9). */
  | "ready"
  /** Login failed (CLI error, timeout, smoke failed) — recoverable; the user re-triggers. */
  | "error";

/** params for "beginLogin" (§L.2.2) — NON-SESSION (no sessionKey). */
export interface RpcBeginLoginParams {
  readonly scope?: ProviderLoginScope;
  readonly provider: RpcProviderKind;
}
/** result for "beginLogin" (§L.2.2). */
export interface RpcBeginLoginResult {
  /** Opaque server-minted handle for this login flow; echoed by poll/submit/cancel. */
  readonly loginId: string;
  readonly status: LoginFlowStatus;
  /** ONLY the allowlisted surface (§L.6.2) — never raw pane text. Present while awaiting. */
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  /** Redacted (§6.4/§L.6.3) human-readable detail on "error". Safe to log. */
  readonly message?: string;
}

/** params for "pollLogin" (§L.2.3). */
export interface RpcPollLoginParams {
  readonly scope?: ProviderLoginScope;
  readonly provider: RpcProviderKind;
  readonly loginId: string;
}
/** result for "pollLogin" (§L.2.3) — same shape as begin (loginId echoed). */
export interface RpcPollLoginResult {
  readonly loginId: string;
  readonly status: LoginFlowStatus;
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  readonly message?: string;
}

/** params for "submitLoginToken" (paste mode, §L.2.3). The `token` is AUTH MATERIAL (§L.6.3). */
export interface RpcSubmitLoginTokenParams {
  readonly scope?: ProviderLoginScope;
  readonly provider: RpcProviderKind;
  readonly loginId: string;
  /**
   * The authorization code/token the user pasted from the browser. Crosses api → cli-runner
   * ONLY in this socket payload — NEVER logged (frame bodies never logged, §6.4), NEVER
   * persisted, NEVER echoed in any result, NEVER in argv/env/launch-line. The server feeds it
   * into the captured login pane via send-keys (least-leaky — NOT in /proc/cmdline; the pane is
   * read only by `extractSurface`, which never echoes input). Scrubbed by `redactExact` in any
   * error (§L.6.3 — `redactSecrets` alone does not match an arbitrary code).
   */
  readonly token: string;
}
/** result for "submitLoginToken" (§L.2.3). */
export interface RpcSubmitLoginTokenResult {
  readonly loginId: string;
  readonly status: LoginFlowStatus;
  readonly message?: string;
}

/** params for "cancelLogin" (§L.2.3). */
export interface RpcCancelLoginParams {
  readonly scope?: ProviderLoginScope;
  readonly provider: RpcProviderKind;
  readonly loginId: string;
}
/** result for "cancelLogin" (§L.2.3) — idempotent (cancelling an absent/ended login is ok). */
export interface RpcCancelLoginResult {
  readonly ok: true;
}
