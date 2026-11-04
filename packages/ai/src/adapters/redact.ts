import { LOG_REDACTED, redactSecrets } from "@moss/shared/log-sanitizer";

/**
 * Secret redaction for multiplexer error text and other server-side logs. The implementation
 * lives in `@moss/shared` so the API and worker processes share it. This re-export keeps the
 * original name for existing callers.
 */
export { redactSecrets };

const REDACTED = LOG_REDACTED;

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
