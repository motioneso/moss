import { types as nodeUtilTypes } from "node:util";

export type ToolDependencyCause =
  | "upstream_connection_refused"
  | "upstream_unreachable"
  | "upstream_timeout"
  | "upstream_http_error";

const CONNECTION_REFUSED_CODES = new Set(["ECONNREFUSED"]);
const UNREACHABLE_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH"
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

/**
 * Plain-English text for each cause, as the USER will eventually read it.
 *
 * The cause ids above are operator vocabulary and stay in the structured log, but the string this
 * maps to is handed to the language model as the tool's error text, and a model will happily
 * repeat that text back to the user word for word. "upstream_connection_refused" in a chat reply
 * is internal jargon leaking to a non-technical reader, so the visible half is written in ordinary
 * words while the loggable half stays machine-readable. Deliberately vague about WHICH service:
 * naming the dependency would start leaking infrastructure detail into chat, which is exactly what
 * this whole path exists to prevent.
 */
const CAUSE_TEXT: Record<ToolDependencyCause, string> = {
  upstream_connection_refused: "could not connect to a service it needs",
  upstream_unreachable: "could not reach a service it needs",
  upstream_timeout: "a service it needs did not respond in time",
  upstream_http_error: "a service it needs returned an error"
};

/** The user-visible half of a classified cause. Never includes the cause id itself. */
export function describeToolDependencyCause(cause: ToolDependencyCause): string {
  return CAUSE_TEXT[cause];
}

interface SafeErrorFields {
  code?: unknown;
  name?: unknown;
  statusCode?: unknown;
  status?: unknown;
  cause?: unknown;
}

/**
 * Reads only .code/.name/.statusCode/.status off a value already confirmed native-error by the
 * caller. Never called on an unbranded value — property access on a Proxy invokes its traps
 * regardless of try/catch, so the brand check must happen before this, not instead of it.
 */
function classifyBrandedFields(fields: SafeErrorFields): ToolDependencyCause | null {
  // Each field is read into a local ONCE. A subclass of Error may define any of these as a getter,
  // and a getter is code the dependency chose to run; reading twice would run it twice and would
  // also let the value change between the type check and its use.
  const rawCode = fields.code;
  const rawName = fields.name;
  const rawStatusCode = fields.statusCode;
  const rawStatus = fields.status;

  const code = typeof rawCode === "string" ? rawCode : undefined;
  const name = typeof rawName === "string" ? rawName : undefined;
  const status =
    typeof rawStatusCode === "number"
      ? rawStatusCode
      : typeof rawStatus === "number"
        ? rawStatus
        : undefined;

  if (code !== undefined && CONNECTION_REFUSED_CODES.has(code))
    return "upstream_connection_refused";
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return "upstream_unreachable";
  if (name === "AbortError" || (code !== undefined && TIMEOUT_CODES.has(code)))
    return "upstream_timeout";
  if (status !== undefined && status >= 400) return "upstream_http_error";
  return null;
}

/**
 * Classifies a first-party tool's thrown dependency failure into a fixed, safe vocabulary.
 * Callers must only invoke this on a throw from a tool with isExternal === false — that trusts
 * the TOOL, not the shape of what it throws, so this function is itself safe against a hostile
 * Proxy or hostile .cause: it brand-checks with util.types.isNativeError (a trap-free internal
 * V8 check) before ever reading a property, on both the top-level value and its cause. Never
 * reads .message or a stack, never logs or returns the value itself.
 */
export function classifyToolDependencyFailure(error: unknown): ToolDependencyCause | null {
  try {
    if (!nodeUtilTypes.isNativeError(error)) return null;
    const top = error as SafeErrorFields;
    const direct = classifyBrandedFields(top);
    if (direct !== null) return direct;

    const cause = top.cause;
    if (!nodeUtilTypes.isNativeError(cause)) return null;
    return classifyBrandedFields(cause as SafeErrorFields);
  } catch {
    return null;
  }
}

/**
 * Trap-free error name for logging (never .message/stack). Same brand-check discipline as
 * classifyToolDependencyFailure — only ever called on an isExternal===false tool's throw.
 */
export function safeErrorName(error: unknown): string | undefined {
  try {
    if (!nodeUtilTypes.isNativeError(error)) return undefined;
    const name = (error as SafeErrorFields).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
