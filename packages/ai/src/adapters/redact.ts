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
  /jst_[A-Za-z0-9_-]+/g,
  // Common provider/API key prefixes.
  /\bsk-(?:(?:ant|proj|live|test)[-_])?[A-Za-z0-9][A-Za-z0-9_-]+\b/gi,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gi,
  /\b(?:ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/gi,
  // Secret-bearing query parameters, preserving the URL key and separators.
  /([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)=)[^&#\s]+/gi,
  // Secret-bearing environment assignments.
  /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH(?:ORIZATION)?|CLIENT[_-]?SECRET|PASSWORD|SECRET|TOKEN|KEY)=[^&\s}]+/gi,
  // Secret-bearing JSON/object fields. Keep the field name and JSON quoting intact.
  /(["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)["']?\s*:\s*)(["']?)([^"'\s,}]+)\2/gi
];

/** Replace any token-bearing substring with a fixed marker. Safe on undefined/empty input. */
export function redactSecrets(text: string | undefined): string {
  if (!text) return "";
  let out = text;
  out = out.replace(PATTERNS[0]!, REDACTED);
  out = out.replace(PATTERNS[1]!, REDACTED);
  out = out.replace(PATTERNS[2]!, REDACTED);
  out = out.replace(PATTERNS[3]!, REDACTED);
  out = out.replace(PATTERNS[4]!, REDACTED);
  out = out.replace(PATTERNS[5]!, REDACTED);
  out = out.replace(PATTERNS[6]!, `$1${REDACTED}`);
  out = out.replace(PATTERNS[7]!, REDACTED);
  out = out.replace(PATTERNS[8]!, `$1$2${REDACTED}$2`);
  return out;
}

/**
 * Scrub the EXACT literal `secret` value from `text` (login-contract §L.6.3, HIGH-1). The
 * Shape-based {@link redactSecrets} still cannot identify an arbitrary OAuth/device/paste
 * authorization code a provider CLI echoes into stderr. The login service holds the in-flight
 * pasted token in memory and runs this over any error/surfaced string BEFORE it crosses the socket
 * — a literal-substring scrub IN ADDITION TO `redactSecrets`. A short/empty secret (`< 4` chars) is
 * treated as not-a-secret (a 1–3 char value would over-redact ordinary text, and a real
 * authorization code is always long) and returned unchanged.
 */
export function redactExact(text: string | undefined, secret: string | undefined): string {
  if (!text) return "";
  if (!secret || secret.length < 4) return text;
  // Escape regex metacharacters in the literal secret, then replace every occurrence.
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "g"), REDACTED);
}
