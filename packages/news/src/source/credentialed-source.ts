// packages/news/src/source/credentialed-source.ts
// #2007 (part of #950) — the adapter that turns one reviewed connection into one outbound
// request, and the mapping from its sanitized items onto the News headline shape.
//
// Two rules shape everything here:
//   1. The request is built from the connection declaration only. The caller contributes a topic
//      key, which selects one of the connection's pre-written value sets — never a value. There
//      is no path from user input to a host, path, header name or query value.
//   2. A failure says only "authentication failed" or "temporarily unavailable". Upstream error
//      text routinely echoes the request, and the request carries the key, so no upstream
//      message, header, body or URL is ever attached to what we throw.
import type { NewsHeadline } from "@moss/shared";
import {
  createKeyedDatasetClient,
  KeyedCredentialUnavailableError,
  type DatasetLogger
} from "@moss/datasets";
import type { KeyedDatasetClientDeps } from "@moss/datasets";
import type { DataContextDb } from "@moss/db";
import type { ExternalSourceAdapter, ExternalSourceAdapterContext } from "@moss/module-sdk";

import type { NewsCredentialCipherPort } from "../credential-cipher-port.js";
import type { NewsCredentialEnvelopeReader } from "./credential-lookup.js";
import { createNewsCredentialLookup } from "./credential-lookup.js";
import type { PublisherConnection, SanitizedPublisherItem } from "./publisher-connection.js";
import { NEWSAPI_DATASET_KEY } from "./newsapi-connection.js";
import { stableIdForUrl } from "./rss-source.js";

/** The only two outcomes a person is ever told about. */
export type CredentialedPublisherFailure = "authentication_failed" | "temporarily_unavailable";

const FAILURE_TEXT: Readonly<Record<CredentialedPublisherFailure, string>> = Object.freeze({
  authentication_failed: "authentication failed",
  temporarily_unavailable: "temporarily unavailable"
});

/**
 * Carries the outcome word and nothing else. No `cause`, because attaching the upstream error
 * would smuggle its message — which can contain the URL the key was sent to — into every log
 * line that serializes this.
 */
export class CredentialedPublisherError extends Error {
  override readonly name = "CredentialedPublisherError";

  constructor(readonly failure: CredentialedPublisherFailure) {
    super(FAILURE_TEXT[failure]);
  }
}

/** The only caller-influenced input: which topic to ask for, or null for the connection default. */
export interface CredentialedPublisherParams {
  readonly topicKey: string | null;
}

/** Status codes that mean the person's own key was rejected, rather than the publisher wobbling. */
const AUTH_FAILURE_STATUSES: readonly number[] = Object.freeze([401, 403]);

/**
 * A header value may only contain printable ASCII. A key carrying a line break could otherwise
 * be an attempt to append a second header to the request. The fetch implementation refuses this
 * too, but a refusal there arrives as a generic error, and this is not a thing to leave to a
 * dependency's discretion.
 */
const SAFE_HEADER_VALUE = /^[\x20-\x7e]+$/;

function readTopicKey(params: Record<string, unknown>): string | null {
  const value = params.topicKey;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Builds the request URL from the declaration alone. The topic key is used as a lookup into the
 * connection's own table and never as a value, so an unknown topic falls back to the default set
 * rather than travelling upstream.
 */
export function buildCredentialedRequestUrl(
  connection: PublisherConnection,
  topicKey: string | null
): string {
  const url = new URL(connection.endpoint);
  // hasOwnProperty, not a plain index read: a topic key of "constructor" or "__proto__" would
  // otherwise find something inherited from Object.prototype, and the request would silently go
  // out with no topic values instead of the connection's own default set.
  const declaredTopic =
    topicKey !== null && Object.prototype.hasOwnProperty.call(connection.topicQuery, topicKey)
      ? connection.topicQuery[topicKey]
      : undefined;
  const topicValues = declaredTopic ?? connection.topicQuery.default;
  if (!topicValues) {
    // The registry validator rejects a connection with no default set, so reaching this means
    // the declaration was built past that check. Refuse rather than send a bare endpoint.
    throw new Error("publisher connection has no default topic query");
  }

  for (const [name, value] of Object.entries(connection.fixedQuery)) {
    url.searchParams.set(name, value);
  }
  for (const [name, value] of Object.entries(topicValues)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

async function fetchSanitizedItems(
  connection: PublisherConnection,
  ctx: ExternalSourceAdapterContext,
  topicKey: string | null
): Promise<SanitizedPublisherItem[]> {
  const apiKey = typeof ctx.apiKey === "string" ? ctx.apiKey.trim() : "";
  if (apiKey.length === 0 || !SAFE_HEADER_VALUE.test(apiKey)) {
    // No request is attempted, for a missing key or a malformed one. An unauthenticated fallback
    // would quietly change who the publisher thinks is asking, and would look like success to
    // everything downstream.
    throw new CredentialedPublisherError("temporarily_unavailable");
  }

  let response: Response;
  try {
    response = await ctx.fetchFn(buildCredentialedRequestUrl(connection, topicKey), {
      method: connection.method,
      headers: { [connection.apiKeyHeader]: apiKey, accept: "application/json" }
    });
  } catch {
    // Timeout, connection refused, host pinning refusal: all "try again later" from here, and
    // the underlying error is dropped rather than wrapped because it names the URL.
    throw new CredentialedPublisherError("temporarily_unavailable");
  }

  if (!response.ok) {
    throw new CredentialedPublisherError(
      AUTH_FAILURE_STATUSES.includes(response.status)
        ? "authentication_failed"
        : "temporarily_unavailable"
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A truncated body (the response byte cap did its job) or a non-JSON error page.
    throw new CredentialedPublisherError("temporarily_unavailable");
  }

  try {
    return connection.parse(body, connection);
  } catch {
    // A changed or unexpected shape is a failure, not "the publisher had no news today".
    throw new CredentialedPublisherError("temporarily_unavailable");
  }
}

/** Validate a candidate key without storing it or exposing the provider response. */
export async function validateCredentialedPublisherKey(
  connection: PublisherConnection,
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  await fetchSanitizedItems(connection, { fetchFn, apiKey }, null);
}

/**
 * The `ExternalSourceAdapter` the keyed dataset runtime dispatches to. It uses only the pinned
 * `fetchFn` and the per-call key it is handed; it holds neither beyond the call.
 */
export function createCredentialedPublisherAdapter(
  connection: PublisherConnection
): ExternalSourceAdapter {
  return {
    async fetchDataset(
      _datasetKey: string,
      params: Record<string, unknown>,
      ctx: ExternalSourceAdapterContext
    ): Promise<unknown> {
      return fetchSanitizedItems(connection, ctx, readTopicKey(params));
    }
  };
}

const CREDENTIAL_DATASET_TTL_MS = 10 * 60 * 1_000;

/**
 * Builds the News-owned reader used by compilation workers. The keyed dataset runtime performs
 * the credential lookup before every cache read, so revocation is immediate and cache entries
 * are isolated by owner, source, and generation.
 */
export function createNewsCredentialedSourceReader(deps: {
  readonly connection: PublisherConnection;
  readonly credentials: NewsCredentialEnvelopeReader;
  readonly cipher: NewsCredentialCipherPort;
  readonly logger?: DatasetLogger;
  readonly createFetch?: KeyedDatasetClientDeps["createFetch"];
}) {
  const { connection } = deps;
  const client = createKeyedDatasetClient<DataContextDb>(
    {
      id: connection.id,
      fetchHosts: connection.fetchHosts,
      timeoutMs: connection.timeoutMs,
      maxResponseBytes: connection.maxResponseBytes,
      minIntervalMs: connection.minIntervalMs,
      datasets: [{ key: NEWSAPI_DATASET_KEY, ttlMs: CREDENTIAL_DATASET_TTL_MS }]
    },
    createCredentialedPublisherAdapter(connection),
    createNewsCredentialLookup({ reader: deps.credentials, cipher: deps.cipher }),
    {
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.createFetch ? { createFetch: deps.createFetch } : {})
    }
  );

  return async (
    scopedDb: DataContextDb,
    input: { readonly actorUserId: string; readonly sourceId: string }
  ): Promise<
    | { readonly items: readonly SanitizedPublisherItem[] }
    | { readonly failure: CredentialedPublisherFailure }
  > => {
    try {
      const result = await client.getDataset<SanitizedPublisherItem[]>({
        actorUserId: input.actorUserId,
        sourceId: input.sourceId,
        datasetKey: NEWSAPI_DATASET_KEY,
        params: { topicKey: null },
        credentialContext: scopedDb
      });
      return { items: result.data };
    } catch (error) {
      if (error instanceof KeyedCredentialUnavailableError) {
        return { failure: "authentication_failed" };
      }
      if (error instanceof CredentialedPublisherError) {
        return { failure: error.failure };
      }
      return { failure: "temporarily_unavailable" };
    }
  };
}

/**
 * Sanitized item -> News headline. The id comes from the article link via the same hash the feed
 * path uses, so the same story arriving from a feed and from a keyed publisher collapses into one
 * entry. The upstream publisher name is kept as the visible label so attribution survives.
 */
export function toCredentialedHeadline(
  item: SanitizedPublisherItem,
  context: {
    readonly sourceKey: string;
    readonly topicKey: string | null;
    readonly topicLabel: string | null;
  }
): NewsHeadline {
  return {
    id: stableIdForUrl(item.url),
    sourceKey: context.sourceKey,
    sourceLabel: item.providerName,
    topicKey: context.topicKey,
    topicLabel: context.topicLabel,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    imageUrl: item.imageUrl,
    faviconUrl: faviconProxyUrlForArticle(item.url),
    summary: item.summary
  };
}

/** Same-origin favicon proxy path for the article's own domain; null when the URL won't parse. */
function faviconProxyUrlForArticle(url: string): string | null {
  try {
    return `/api/news/favicon/${encodeURIComponent(new URL(url).hostname)}`;
  } catch {
    return null;
  }
}
