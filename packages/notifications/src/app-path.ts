/**
 * Same-origin app path check (#743 security finding 4).
 *
 * A notification's click target must stay on this app. "Starts with a slash and has no
 * colon" is not enough: browsers parse "/\\evil.com" and "/%5Cevil.com" as a scheme-relative
 * URL, and strip tabs and newlines before parsing, so those would all leave the origin. This
 * is the single rule every layer uses: the module RPC boundary, the notifications
 * repository, the push payload builder, and (in plainer form) the service worker's click
 * handler.
 */

const PLACEHOLDER_ORIGIN = "https://app.invalid";
// eslint-disable-next-line no-control-regex
const CONTROL_REGEX = /[\x00-\x1f\x7f]/;

/** True when `value` is a path on this app: leading slash, no way to change origin. */
export function isSameOriginAppPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return false;
  }
  if (value.includes(":") || value.includes("\\") || CONTROL_REGEX.test(value)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return false;
  }
  return parsed.origin === PLACEHOLDER_ORIGIN && parsed.href.startsWith(`${PLACEHOLDER_ORIGIN}/`);
}

/** The path when it passes the check, otherwise null. For places that degrade rather than fail. */
export function sameOriginAppPathOrNull(value: unknown): string | null {
  return isSameOriginAppPath(value) ? value : null;
}
