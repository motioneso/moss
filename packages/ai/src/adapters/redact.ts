/**
 * Secret redaction for multiplexer error text. A failed `open()`/`submit()` surfaces the
 * backend's stderr in an Error message, and the live-chat route logs that error server-side.
 * tmux/herdr can echo the failing command back on stderr, and a CLI launch line carries the
 * per-session MCP bearer token (`JARVIS_MCP_TOKEN=jst_…`, `Bearer jst_…`). Scrubbing those
 * shapes before the text enters an Error keeps the token out of server logs even on the
 * failure path (secrets-never-escape, defense-in-depth — the token is also short-lived and
 * RLS-scoped, so this is hardening, not a known live leak).
 */
const REDACTED = "[redacted]";
const PATTERNS: readonly RegExp[] = [
  // `JARVIS_MCP_TOKEN=<value>` env-var prefix on the launch line (Codex path).
  /JARVIS_MCP_TOKEN=\S+/gi,
  // `Authorization: Bearer <value>` header form, including RFC-style folded continuations.
  /Bearer[ \t]+\S+(?:\r?\n[ \t]+\S+)*/gi,
  // Bare session-token tokens (`jst_…`) anywhere they appear.
  /jst_[A-Za-z0-9_-]+/g,
  // Query-param secrets, including common OAuth credentials and encoded `_` separators.
  /[?&](?:key|api(?:[_-]|%5[fF])?key|code|token|access(?:_|%5[fF])?token|client(?:_|%5[fF])?secret|refresh(?:_|%5[fF])?token|secret|password)=[^&\s]+/gi,
  // Sensitive header values not covered by Bearer (provider keys and HTTP Basic credentials).
  /X-API-Key\s*:\s*\S+/gi,
  /Basic[ \t]+\S+/gi,
  // JSON error bodies commonly returned by OAuth/provider clients.
  /"(?:password|access_token|client_secret|refresh_token)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
  // Bare provider API keys (`sk-…`) with no `Bearer` prefix.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // URL userinfo credentials (`user:pass@host`).
  /[A-Za-z0-9_.+-]+:[^\s@/]+@/g
];

/** Replace any token-bearing substring with a fixed marker. Safe on undefined/empty input. */
export function redactSecrets(text: string | undefined): string {
  if (!text) return "";
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Scrub the EXACT literal `secret` value from `text` (login-contract §L.6.3, HIGH-1). The
 * shape-based {@link redactSecrets} only matches known credential forms; an arbitrary
 * OAuth/device/paste authorization code a provider CLI echoes into stderr/error text would NOT
 * be caught. The login service holds the in-flight
 * pasted token in memory and runs this over any error/surfaced string BEFORE it crosses the
 * socket — a literal-substring scrub IN ADDITION TO `redactSecrets`. A short/empty secret
 * (`< 4` chars) is treated as not-a-secret (a 1–3 char value would over-redact ordinary text,
 * and a real authorization code is always long) and returned unchanged.
 */
export function redactExact(text: string | undefined, secret: string | undefined): string {
  if (!text) return "";
  if (!secret || secret.length < 4) return text;
  // Escape regex metacharacters in the literal secret, then replace every occurrence.
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "g"), REDACTED);
}
