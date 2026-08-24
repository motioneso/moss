export const SPORTS_BROWSER_LIMITS = Object.freeze({
  deadlineMs: 20_000,
  maxRequests: 40,
  maxCandidateEvidence: 5,
  maxConcurrentRequests: 4,
  maxAggregateBytes: 10 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRenderResultBytes: 512 * 1024,
  maxJsonBodyBytes: 16 * 1024,
  maxRequestIdChars: 64,
  maxUrlChars: 4_096
});

export const SPORTS_BROWSER_ROUTES = Object.freeze({
  fetch: "/v1/fetch",
  render: "/v1/render"
});

export const SPORTS_BROWSER_SOCKETS = Object.freeze({
  broker: "/run/moss-sports-browser/broker.sock",
  renderer: "/run/moss-sports-browser/renderer.sock"
});

export type BrowserResourceType = "document" | "fetch" | "xhr" | "script" | "stylesheet";

export interface BrowserFetchRequest {
  readonly jobId: string;
  readonly requestId: string;
  readonly capability: string;
  readonly url: string;
  readonly method: "GET" | "HEAD";
  readonly resourceType: BrowserResourceType;
}

export interface BrowserRenderRequest {
  readonly jobId: string;
  readonly capability: string;
  readonly url: string;
}

export type BrowserRenderFailureReason = "cancelled" | "timeout" | "render_failed" | "unsupported";

export type BrowserRenderResult =
  | {
      readonly ok: true;
      readonly jobId: string;
      readonly finalUrl: string;
      readonly domHtml: string;
    }
  | {
      readonly ok: false;
      readonly jobId: string;
      readonly reason: BrowserRenderFailureReason;
    };

export type BrowserProtocolParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "body_too_large" | "invalid_json" | "invalid_message";
    };

const FETCH_KEYS = new Set(["jobId", "requestId", "capability", "url", "method", "resourceType"]);
const RENDER_KEYS = new Set(["jobId", "capability", "url"]);
const RENDER_SUCCESS_KEYS = new Set(["ok", "jobId", "finalUrl", "domHtml"]);
const RENDER_FAILURE_KEYS = new Set(["ok", "jobId", "reason"]);
const RENDER_FAILURE_REASONS = new Set(["cancelled", "timeout", "render_failed", "unsupported"]);
const RESOURCE_TYPES = new Set<BrowserResourceType>([
  "document",
  "fetch",
  "xhr",
  "script",
  "stylesheet"
]);
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function parseHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > SPORTS_BROWSER_LIMITS.maxUrlChars) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function parseFetchRequest(value: unknown): BrowserFetchRequest | undefined {
  if (!isRecord(value) || !hasExactKeys(value, FETCH_KEYS)) return undefined;
  const url = parseHttpsUrl(value.url);
  if (
    typeof value.jobId !== "string" ||
    !UUID_PATTERN.test(value.jobId) ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > SPORTS_BROWSER_LIMITS.maxRequestIdChars ||
    !ID_PATTERN.test(value.requestId) ||
    typeof value.capability !== "string" ||
    !CAPABILITY_PATTERN.test(value.capability) ||
    (value.method !== "GET" && value.method !== "HEAD") ||
    typeof value.resourceType !== "string" ||
    !RESOURCE_TYPES.has(value.resourceType as BrowserResourceType) ||
    !url
  ) {
    return undefined;
  }
  return {
    jobId: value.jobId,
    requestId: value.requestId,
    capability: value.capability,
    url,
    method: value.method,
    resourceType: value.resourceType as BrowserResourceType
  };
}

function parseRenderRequest(value: unknown): BrowserRenderRequest | undefined {
  if (!isRecord(value) || !hasExactKeys(value, RENDER_KEYS)) return undefined;
  const url = parseHttpsUrl(value.url);
  if (
    typeof value.jobId !== "string" ||
    !UUID_PATTERN.test(value.jobId) ||
    typeof value.capability !== "string" ||
    !CAPABILITY_PATTERN.test(value.capability) ||
    !url
  ) {
    return undefined;
  }
  return { jobId: value.jobId, capability: value.capability, url };
}

function parseRenderResult(value: unknown): BrowserRenderResult | undefined {
  if (!isRecord(value) || typeof value.jobId !== "string" || !UUID_PATTERN.test(value.jobId)) {
    return undefined;
  }
  if (value.ok === true && hasExactKeys(value, RENDER_SUCCESS_KEYS)) {
    const finalUrl = parseHttpsUrl(value.finalUrl);
    return typeof value.domHtml === "string" && finalUrl
      ? { ok: true, jobId: value.jobId, finalUrl, domHtml: value.domHtml }
      : undefined;
  }
  if (
    value.ok === false &&
    hasExactKeys(value, RENDER_FAILURE_KEYS) &&
    typeof value.reason === "string" &&
    RENDER_FAILURE_REASONS.has(value.reason)
  ) {
    return { ok: false, jobId: value.jobId, reason: value.reason as BrowserRenderFailureReason };
  }
  return undefined;
}

function parseBody<T>(
  body: Uint8Array,
  parse: (value: unknown) => T | undefined,
  maxBytes = SPORTS_BROWSER_LIMITS.maxJsonBodyBytes
): BrowserProtocolParseResult<T> {
  if (body.byteLength > maxBytes) {
    return { ok: false, reason: "body_too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const parsed = parse(value);
  return parsed ? { ok: true, value: parsed } : { ok: false, reason: "invalid_message" };
}

export function parseBrowserFetchBody(
  body: Uint8Array
): BrowserProtocolParseResult<BrowserFetchRequest> {
  return parseBody(body, parseFetchRequest);
}

export function parseBrowserRenderBody(
  body: Uint8Array
): BrowserProtocolParseResult<BrowserRenderRequest> {
  return parseBody(body, parseRenderRequest);
}

export function parseBrowserRenderResultBody(
  body: Uint8Array
): BrowserProtocolParseResult<BrowserRenderResult> {
  return parseBody(body, parseRenderResult, SPORTS_BROWSER_LIMITS.maxRenderResultBytes);
}
