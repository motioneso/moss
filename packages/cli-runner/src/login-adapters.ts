/**
 * §L.1 LOGIN ADAPTERS — the server-side auth-flow ALLOWLIST.
 *
 * A typed, server-side, compile-time-constant registry mapping each LOGIN-supported
 * provider to exactly one login adapter (command + surface parser + URL allowlist). THE
 * REGISTRY IS THE ALLOWLIST: a provider absent here is NOT login-supported — `beginLogin`
 * for it returns the catalog/adapter-blocked `bad_request` (§L.2.4). Install-support and
 * login-support are SEPARATE axes (§L.9.2): a provider may be install-`supported` (catalog)
 * yet have no login adapter (codex's headless fallback).
 *
 * SERVER-SIDE ONLY (cli-runner): the concrete values + `extractSurface` parsers are the
 * auth-flow allowlist and must NEVER ship to the browser bundle. The shared TYPES live in
 * `@moss/chat/live` (packages/chat/src/live/login-contract.ts).
 *
 * Pinned 2026-06-20 (Phase 3) against the catalog-pinned CLI versions (claude 2.1.183,
 * codex 0.141.0). The concrete `loginArgv` / URL allowlists / userCode patterns below are
 * NORMATIVE; the §L.9.2 release smoke VALIDATES them against the real CLIs (and may force
 * codex login to `blocked` if its headless flow cannot complete — §L.9.2).
 */

import type {
  LoginAdapter,
  LoginAdapterRegistry,
  LoginAuthUrlPattern,
  LoginSurface,
  ProviderCatalog,
  RpcProviderKind
} from "@moss/chat/live";

import { PROVIDER_CATALOG } from "./catalog.js";

// ---------------------------------------------------------------------------
// §L.6.2 — the surface chokepoint: parse ONLY an allowlisted URL + user code
// ---------------------------------------------------------------------------

/** Match a host against a pattern that may be exact or a leading "*." wildcard (suffix). */
function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".anthropic.com" — match any subdomain (not the bare apex)
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

/** True iff `url` is https AND its host+path match an allowlist entry (§L.6.2). */
function urlAllowed(url: string, allowlist: readonly LoginAuthUrlPattern[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  for (const entry of allowlist) {
    if (hostMatches(parsed.hostname, entry.host) && parsed.pathname.startsWith(entry.pathPrefix)) {
      return true;
    }
  }
  return false;
}

/** A liberal URL scanner — finds https URLs in a pane snapshot for allowlist filtering. */
const URL_SCAN_RE = /https:\/\/[^\s"'<>)\]]+/gi;

/**
 * Build a pure `extractSurface` over a provider's allowlist + userCode pattern (§L.1.1).
 * Returns at most `{ authorizationUrl, userCode }`; a URL failing scheme/host/path or a code
 * failing the pattern is DROPPED. Never echoes raw input/output.
 */
function makeExtractSurface(
  allowlist: readonly LoginAuthUrlPattern[],
  userCodePattern: RegExp
): (paneSnapshot: string) => LoginSurface {
  return (paneSnapshot: string): LoginSurface => {
    const out: { authorizationUrl?: string; userCode?: string } = {};
    // First allowlisted https URL in the pane.
    const urls = paneSnapshot.match(URL_SCAN_RE) ?? [];
    for (const candidate of urls) {
      // Strip a trailing punctuation char a CLI may print after the URL.
      const cleaned = candidate.replace(/[.,;]+$/, "");
      if (urlAllowed(cleaned, allowlist)) {
        out.authorizationUrl = cleaned;
        break;
      }
    }
    // A device/pairing user code, if the provider's flow displays one (tight pattern).
    // Scanned per whitespace-delimited token so a long line never matches by accident.
    for (const token of paneSnapshot.split(/\s+/)) {
      if (userCodePattern.test(token)) {
        out.userCode = token;
        break;
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// §L.1.2 — the frozen MVP adapter values (claude + codex; agy absent/blocked)
// ---------------------------------------------------------------------------

const ANTHROPIC_AUTH_URLS: readonly LoginAuthUrlPattern[] = [
  // claude 2.1.183 `setup-token` prints a claude.com OAuth URL (`/cai/oauth/authorize`) —
  // Claude's console moved to claude.com. The legacy claude.ai/console.anthropic.com hosts
  // are retained for older CLI builds + the interactive flow. (Verified against the pinned
  // CLI version's real pane output; an allowlist miss DROPS the URL → login surfaces none.)
  { host: "claude.com", pathPrefix: "/cai/oauth" },
  { host: "claude.com", pathPrefix: "/oauth" },
  { host: "claude.ai", pathPrefix: "/oauth" },
  { host: "console.anthropic.com", pathPrefix: "/oauth" }
];

const CODEX_AUTH_URLS: readonly LoginAuthUrlPattern[] = [
  // `codex login --device-auth` prints the device-authorization URL
  // (https://auth.openai.com/codex/device) plus a one-time code. The legacy
  // /authorize + /oauth entries are retained for older CLI builds that may print
  // an OAuth-authorize URL instead.
  { host: "auth.openai.com", pathPrefix: "/codex/device" },
  { host: "auth.openai.com", pathPrefix: "/authorize" },
  { host: "auth.openai.com", pathPrefix: "/oauth" }
];

const GOOGLE_AUTH_URLS: readonly LoginAuthUrlPattern[] = [
  // `gemini` 0.57.0, when it cannot open a browser, prints the google-auth-library authorize
  // URL (https://accounts.google.com/o/oauth2/v2/auth?…) and then waits for the code pasted
  // back from the browser. Host+path both pinned: `/o/oauth2` is narrow enough to pass the
  // §L.1.3 too-broad check and excludes the rest of accounts.google.com (ServiceLogin etc.).
  { host: "accounts.google.com", pathPrefix: "/o/oauth2" }
];

/**
 * Opaque paste/device codes — bounded length, no whitespace. NOT used to surface the user's
 * pasted token (post-submit surfacing is suppressed, §L.6.2); only a device/pairing code a
 * provider's flow DISPLAYS in the pre-paste phase.
 */
const USER_CODE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

/**
 * codex device-auth user code — the exact shape `codex login --device-auth` prints, e.g.
 * `4DUN-GY7Y3` (4 alnum, hyphen, 5 alnum). Tighter than {@link USER_CODE_PATTERN} so incidental
 * pane words like `Starting` are never mistaken for the code.
 */
const CODEX_DEVICE_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{5}$/;

/**
 * (#363) claude `setup-token` prints a long-lived OAuth token (`sk-ant-oat…`) on success. The
 * login service captures it from the pane (post-paste) and persists it via the token store; it
 * is a SECRET (never surfaced). Tight: the `sk-ant-oat` prefix + the token charset, bounded.
 */
const ANTHROPIC_TOKEN_CAPTURE = /sk-ant-oat[A-Za-z0-9_-]{20,300}/;

/**
 * The gemini paste flow displays NO user code — it prints a link and waits for the code the
 * BROWSER gives the user. So this pattern deliberately matches nothing: `(?!)` is a negative
 * lookahead on the empty string, which can never succeed. Do NOT swap in
 * {@link USER_CODE_PATTERN} here: it accepts any 6-128 char word, so the first ordinary word in
 * the pane (`authorize`, `following`, …) would be surfaced to the user AS their sign-in code.
 */
const GEMINI_NO_DISPLAYED_CODE_PATTERN = /(?!)/;

const RAW_ADAPTERS: Record<RpcProviderKind, LoginAdapter | undefined> = {
  anthropic: {
    provider: "anthropic",
    // `claude setup-token` is the headless/long-lived-token OAuth flow: it prints an
    // authorization URL and waits for the user to paste the code from the browser. (Interactive
    // `/login` assumes a local browser; the container has none.) Validated by the §L.9.2 smoke.
    loginArgv: ["claude", "setup-token"],
    mode: "paste",
    authUrlAllowlist: ANTHROPIC_AUTH_URLS,
    userCodePattern: USER_CODE_PATTERN,
    extractSurface: makeExtractSurface(ANTHROPIC_AUTH_URLS, USER_CODE_PATTERN),
    // #363: capture the minted setup-token credential from the success pane (claude-scoped).
    tokenCapturePattern: ANTHROPIC_TOKEN_CAPTURE
  },
  "openai-compatible": {
    provider: "openai-compatible",
    // `codex login --device-auth` is the headless/remote-usable flow: it prints
    // https://auth.openai.com/codex/device + a one-time code, then polls its own backend for
    // completion. The default `codex login` uses a localhost:1455 OAuth callback a remote
    // headless container's browser cannot reach. The §L.9.2 smoke confirms this flow at the
    // pinned version; if it cannot complete headlessly, this adapter is REMOVED (codex login
    // ships `blocked`, install stays supported) — exactly like agy.
    loginArgv: ["codex", "login", "--device-auth"],
    // Device auth auto-detects completion (the CLI polls its backend); no code is pasted back.
    mode: "poll",
    authUrlAllowlist: CODEX_AUTH_URLS,
    userCodePattern: CODEX_DEVICE_CODE_PATTERN,
    extractSurface: makeExtractSurface(CODEX_AUTH_URLS, CODEX_DEVICE_CODE_PATTERN)
  },
  google: {
    provider: "google",
    // (#2027) Bare `gemini` with no subcommand: on a home dir whose `.gemini/settings.json`
    // already carries `security.auth.selectedType` (seeded on the login path — see
    // provider-first-run.ts), the CLI goes straight into the OAuth flow. With NO_BROWSER set
    // (sanitized-env.ts) it cannot open a browser, so it prints the authorize URL and waits on
    // the keyboard for the pasted code. loginArgv[0] MUST stay `gemini` — the catalog binary —
    // or §L.1.3 DROPS this adapter with nothing logged and login stays silently unavailable.
    // Deliberately no `--prompt`/`-p`: that is the non-interactive path and it refuses to paste.
    loginArgv: ["gemini"],
    // Link + pasted-code round trip ⇒ paste, not poll: nothing here polls a backend.
    mode: "paste",
    authUrlAllowlist: GOOGLE_AUTH_URLS,
    userCodePattern: GEMINI_NO_DISPLAYED_CODE_PATTERN,
    extractSurface: makeExtractSurface(GOOGLE_AUTH_URLS, GEMINI_NO_DISPLAYED_CODE_PATTERN)
    // Deliberately NO tokenCapturePattern: unlike claude's `setup-token`, gemini prints no
    // credential — it writes its own oauth_creds.json. A capture pattern here could only ever
    // lift something off the pane that should not be surfaced.
  }
};

// ---------------------------------------------------------------------------
// §L.1.3 — adapter validation (rejects an inconsistent registry at load)
// ---------------------------------------------------------------------------

/** Reason an adapter was rejected/dropped at load (for the boot log / the test). */
export interface LoginAdapterIssue {
  readonly provider: RpcProviderKind;
  readonly reason: string;
}

function validateAdapter(
  provider: RpcProviderKind,
  adapter: LoginAdapter,
  catalog: ProviderCatalog
): string | null {
  // No ORPHAN adapter: an adapter requires an install-`supported` catalog entry (§L.1.3).
  const entry = catalog[provider];
  if (!entry || entry.status !== "supported") {
    return "orphan adapter — provider is not install-supported";
  }
  // A PRESENT adapter MUST be complete + non-placeholder (§L.1.3).
  if (adapter.provider !== provider) return "adapter.provider mismatch";
  if (!adapter.loginArgv.length || adapter.loginArgv.some((a) => !a || a.includes("<"))) {
    return "loginArgv is empty or carries a placeholder";
  }
  // loginArgv[0] must equal the catalog binary (run the same pinned binary install placed).
  if (entry.recipe && adapter.loginArgv[0] !== entry.recipe.binary) {
    return `loginArgv[0] "${adapter.loginArgv[0]}" != catalog binary "${entry.recipe.binary}"`;
  }
  if (!adapter.authUrlAllowlist.length) return "authUrlAllowlist is empty";
  for (const e of adapter.authUrlAllowlist) {
    if (!e.host || e.host.includes("<")) return "authUrlAllowlist host empty/placeholder";
    // pathPrefix MUST NOT be "/" or empty — host-only allowlisting is too broad (§L.1.3 MED-1).
    if (!e.pathPrefix || e.pathPrefix === "/")
      return `authUrlAllowlist pathPrefix "${e.pathPrefix}" too broad`;
  }
  return null;
}

/**
 * Validate the raw adapters against the catalog (§L.1.3) and return the frozen registry plus
 * the list of drops. An ORPHAN or incomplete adapter is DROPPED (treated as no adapter — login
 * blocked for that provider), never a hard crash, so a misconfig degrades to "login unavailable"
 * rather than taking down the runner. (claude having a working adapter is a §L.9.2 merge gate.)
 */
export function loadLoginAdapters(
  catalog: ProviderCatalog,
  raw: Record<RpcProviderKind, LoginAdapter | undefined> = RAW_ADAPTERS
): { adapters: LoginAdapterRegistry; issues: LoginAdapterIssue[] } {
  const issues: LoginAdapterIssue[] = [];
  const out: Partial<Record<RpcProviderKind, LoginAdapter>> = {};
  for (const provider of Object.keys(raw) as RpcProviderKind[]) {
    const adapter = raw[provider];
    if (!adapter) continue; // intentionally absent = login-blocked (the allowlist)
    const issue = validateAdapter(provider, adapter, catalog);
    if (issue) {
      issues.push({ provider, reason: issue });
      continue; // drop the bad adapter ⇒ login blocked for it
    }
    out[provider] = adapter;
  }
  return { adapters: Object.freeze(out), issues };
}

/** The validated, frozen login-adapter registry — THE login allowlist (§L.1.2). */
const loadedLogin = loadLoginAdapters(PROVIDER_CATALOG);

/**
 * The validated login allowlist. Consumed by the §L.2.5 connection dispatch / the login service
 * (`hasAdapter`) and the composition-root loginability port. A provider absent here is NOT
 * login-supported — `beginLogin` for it returns the catalog/adapter-blocked `bad_request` (§L.2.4).
 */
export const LOGIN_ADAPTERS: LoginAdapterRegistry = loadedLogin.adapters;

/** Drops recorded by the load-time §L.1.3 validation (orphan / incomplete adapter) — boot log/test. */
export const LOGIN_ADAPTER_ISSUES: readonly LoginAdapterIssue[] = loadedLogin.issues;
