export const SPORTS_BROWSER_LIMITS = Object.freeze({
  deadlineMs: 20_000,
  maxRequests: 40,
  maxCandidateEvidence: 5,
  maxConcurrentRequests: 4,
  maxAggregateBytes: 10 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxJsonBodyBytes: 16 * 1024,
  maxRequestIdChars: 64,
  maxUrlChars: 4_096
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

export type BrowserProtocolParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: "body_too_large" | "invalid_json" | "invalid_message";
    };

const FETCH_KEYS = new Set(["jobId", "requestId", "capability", "url", "method", "resourceType"]);
const RENDER_KEYS = new Set(["jobId", "capability", "url"]);
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
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
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

function parseBody<T>(
  body: Uint8Array,
  parse: (value: unknown) => T | undefined
): BrowserProtocolParseResult<T> {
  if (body.byteLength > SPORTS_BROWSER_LIMITS.maxJsonBodyBytes) {
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
