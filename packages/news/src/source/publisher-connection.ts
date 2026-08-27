// packages/news/src/source/publisher-connection.ts
// #2007 (part of #950) — the reviewed publisher connection declaration and its validator.
//
// A "connection" is a constant written into our own source describing EXACTLY ONE permitted
// outbound request. Nothing at runtime can add one, and no user-supplied value can change the
// host, path, header name or query names of one. That is the whole security posture of this
// slice: the outbound request shape is code, not configuration.
//
// This deliberately does NOT travel through the module manifest's `externalSources` path. That
// path still refuses `credential: "api-key"` (packages/datasets/src/client.ts, and the registry
// guard ahead of it) because it has no per-user secret storage; this file plus the keyed runtime
// in @moss/datasets is the narrower replacement, usable only by connections declared here.
import { assertValidFetchHosts } from "@moss/datasets";

/** Module-wide ceilings. A declaration may be stricter, never looser. */
export const PUBLISHER_MAX_TIMEOUT_MS = 15_000;
export const PUBLISHER_MAX_RESPONSE_BYTES = 1_048_576;
export const PUBLISHER_MAX_ITEMS = 50;
export const PUBLISHER_MIN_INTERVAL_FLOOR_MS = 250;

/**
 * Header names a reviewed connection may send the key in.
 *
 * The spec's rule is "the header name is written down, not computed". A string cannot be asked at
 * runtime how it was produced, so the checkable form of that rule is a frozen allow list: a
 * computed name would still have to land on one of these, and adding one is a source change that
 * goes through review.
 */
export const ALLOWED_API_KEY_HEADERS: readonly string[] = Object.freeze([
  "X-Api-Key",
  "X-API-Key",
  "Api-Key"
]);

/** Query names that would mean the key is travelling in the URL. Compared punctuation-insensitively. */
const SECRET_QUERY_NAMES: readonly string[] = Object.freeze([
  "key",
  "apikey",
  "accesskey",
  "accesstoken",
  "token",
  "auth",
  "authorization",
  "secret",
  "password"
]);

/** A declared query value that looks like it is meant to be filled in with the secret later. */
const SECRET_VALUE_PATTERN = /[{}$]|key|token|secret|bearer|password/i;

/** One upstream item after every text field has been through the News sanitizers. */
export interface SanitizedPublisherItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly imageUrl: string | null;
  readonly summary: string;
  /** Upstream publisher name, carried through so attribution survives into the headline. */
  readonly providerName: string;
}

export interface PublisherConnection {
  /** Stable id. Stored verbatim in app.news_source_credentials.connection_id (#2005). */
  readonly id: string;
  readonly publisherName: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  /**
   * One plain sentence describing what a key for this connection can read. #2008 shows it in
   * News settings before the user pastes anything, so it is required and display-safe: it may
   * never name the header, the endpoint or any part of the request.
   */
  readonly accessSummary: string;
  /** The publisher's own terms, shown as a link next to the key box. https only, or null. */
  readonly termsUrl: string | null;
  /** Exact hosts the pinned fetch may reach. The endpoint host must be one of them. */
  readonly fetchHosts: readonly string[];
  readonly endpoint: string;
  readonly method: "GET";
  readonly apiKeyHeader: string;
  /** Query values sent on every request, regardless of what the caller asked for. */
  readonly fixedQuery: Readonly<Record<string, string>>;
  /**
   * The only caller-influenced part of the request: a News topic key selects one of these
   * pre-written value sets. "default" covers a topic this connection has no equivalent for.
   * There is no free-text value, so a user can never shape the outgoing query string.
   */
  readonly topicQuery: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxItems: number;
  readonly minIntervalMs: number;
  /** Turns a decoded response body into sanitized items. Throws when the body is not the shape. */
  readonly parse: (body: unknown, connection: PublisherConnection) => SanitizedPublisherItem[];
}

function normalizeQueryName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertBound(id: string, label: string, value: number, ceiling: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Publisher connection "${id}" must declare a positive ${label}`);
  }
  if (value > ceiling) {
    throw new Error(
      `Publisher connection "${id}" declares ${label} ${value}, above the ceiling ${ceiling}`
    );
  }
}

function assertQueryTableIsSecretFree(
  id: string,
  label: string,
  table: Readonly<Record<string, string>>
): void {
  for (const [name, value] of Object.entries(table)) {
    if (SECRET_QUERY_NAMES.includes(normalizeQueryName(name))) {
      throw new Error(
        `Publisher connection "${id}" declares ${label} query value "${name}", which would put ` +
          "the credential in the URL; the key travels in the declared header only"
      );
    }
    if (typeof value !== "string" || SECRET_VALUE_PATTERN.test(value)) {
      throw new Error(
        `Publisher connection "${id}" declares ${label} query value "${name}" whose value looks ` +
          "like a placeholder for the credential"
      );
    }
  }
}

/**
 * Runs when the registry is built, in the same spirit as `assertValidFetchHosts`. Every rule here
 * throws — none of them merely documents an expectation, because a validator that only describes
 * a rule reads as a guarantee it does not provide.
 */
export function assertValidPublisherConnection(connection: PublisherConnection): void {
  const { id } = connection;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Publisher connection declares no id");
  }

  assertValidFetchHosts(id, connection.fetchHosts);

  let endpoint: URL;
  try {
    endpoint = new URL(connection.endpoint);
  } catch {
    throw new Error(`Publisher connection "${id}" declares an unparseable endpoint`);
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(`Publisher connection "${id}" endpoint must use https`);
  }
  if (!connection.fetchHosts.includes(endpoint.hostname)) {
    throw new Error(
      `Publisher connection "${id}" endpoint host "${endpoint.hostname}" is not on its own host list`
    );
  }
  if (endpoint.search !== "" || endpoint.hash !== "") {
    throw new Error(
      `Publisher connection "${id}" endpoint must carry no query string or fragment; ` +
        "declare query values in fixedQuery instead"
    );
  }

  if (connection.method !== "GET") {
    throw new Error(`Publisher connection "${id}" must use method GET`);
  }

  const header = connection.apiKeyHeader;
  if (typeof header !== "string" || header.trim().length === 0) {
    throw new Error(`Publisher connection "${id}" declares an empty key header name`);
  }
  if (/\s/.test(header)) {
    throw new Error(
      `Publisher connection "${id}" key header name contains whitespace or a line break`
    );
  }
  if (!ALLOWED_API_KEY_HEADERS.includes(header)) {
    throw new Error(
      `Publisher connection "${id}" key header name "${header}" is not one of the reviewed ` +
        "header names"
    );
  }

  assertQueryTableIsSecretFree(id, "fixed", connection.fixedQuery);
  if (!connection.topicQuery || typeof connection.topicQuery !== "object") {
    throw new Error(`Publisher connection "${id}" declares no topic query table`);
  }
  if (!connection.topicQuery.default) {
    throw new Error(`Publisher connection "${id}" topic query table declares no default`);
  }
  for (const [topic, values] of Object.entries(connection.topicQuery)) {
    assertQueryTableIsSecretFree(id, `topic "${topic}"`, values);
  }

  assertBound(id, "timeoutMs", connection.timeoutMs, PUBLISHER_MAX_TIMEOUT_MS);
  assertBound(id, "maxResponseBytes", connection.maxResponseBytes, PUBLISHER_MAX_RESPONSE_BYTES);
  assertBound(id, "maxItems", connection.maxItems, PUBLISHER_MAX_ITEMS);
  if (
    typeof connection.minIntervalMs !== "number" ||
    !Number.isFinite(connection.minIntervalMs) ||
    connection.minIntervalMs < PUBLISHER_MIN_INTERVAL_FLOOR_MS
  ) {
    throw new Error(
      `Publisher connection "${id}" must declare a minimum request interval of at least ` +
        `${PUBLISHER_MIN_INTERVAL_FLOOR_MS}ms`
    );
  }

  // #2008: the settings screen shows this sentence as the whole explanation of what the user is
  // handing over. A declaration without one would render a key box with nothing above it.
  if (typeof connection.accessSummary !== "string" || connection.accessSummary.trim().length === 0) {
    throw new Error(`Publisher connection "${id}" declares no access summary`);
  }
  if (connection.termsUrl !== null) {
    let terms: URL;
    try {
      terms = new URL(connection.termsUrl);
    } catch {
      throw new Error(`Publisher connection "${id}" declares an unparseable terms link`);
    }
    if (terms.protocol !== "https:") {
      throw new Error(`Publisher connection "${id}" terms link must use https`);
    }
  }

  if (typeof connection.parse !== "function") {
    throw new Error(`Publisher connection "${id}" declares no response parser`);
  }
}

export function assertValidPublisherConnectionRegistry(
  connections: readonly PublisherConnection[]
): void {
  const seen = new Set<string>();
  for (const connection of connections) {
    assertValidPublisherConnection(connection);
    if (seen.has(connection.id)) {
      throw new Error(`Publisher connection registry has a duplicate id "${connection.id}"`);
    }
    seen.add(connection.id);
  }
}
