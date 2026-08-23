import { types as nodeUtilTypes } from "node:util";

export type ToolDependencyCause =
  | "upstream_connection_refused"
  | "upstream_unreachable"
  | "upstream_timeout"
  | "upstream_http_error";

const CONNECTION_REFUSED_CODES = new Set(["ECONNREFUSED"]);
const UNREACHABLE_CODES = new Set(["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH"]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);

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
  const code = typeof fields.code === "string" ? fields.code : undefined;
  const name = typeof fields.name === "string" ? fields.name : undefined;
  const status =
    typeof fields.statusCode === "number"
      ? fields.statusCode
      : typeof fields.status === "number"
        ? fields.status
        : undefined;

  if (code !== undefined && CONNECTION_REFUSED_CODES.has(code)) return "upstream_connection_refused";
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return "upstream_unreachable";
  if (name === "AbortError" || (code !== undefined && TIMEOUT_CODES.has(code))) return "upstream_timeout";
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
