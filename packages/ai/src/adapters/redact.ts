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
  // `Authorization: Bearer <value>` / `Bearer <value>` header form.
  /Bearer\s+\S+/gi,
  // Bare session-token tokens (`jst_…`) anywhere they appear.
  /jst_[A-Za-z0-9_-]+/g
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
 * shape-based {@link redactSecrets} only matches the MCP-token forms (`Bearer …`, `jst_…`,
 * `JARVIS_MCP_TOKEN=…`); an arbitrary OAuth/device/paste authorization code a provider CLI
 * echoes into stderr/error text would NOT be caught. The login service holds the in-flight
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
