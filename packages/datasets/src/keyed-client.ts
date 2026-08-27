// packages/datasets/src/keyed-client.ts
// #2007 (part of #950) — the runtime for sources that need a key the acting person owns.
//
// This sits NEXT TO createDatasetClient, it does not replace or relax it. The existing client
// still refuses `credential: "api-key"` and must keep doing so: that refusal guards the module
// manifest path, which any module can declare into. This runtime is reachable only from a
// connection written into our own reviewed registry.
//
// The two properties that make it safe to hold a key:
//   1. Cache identity includes the person, the source row and the credential generation, so one
//      person's answer can never be served to another and a rotated-away key cannot be reached.
//   2. The credential is looked up before every call, including a cache hit, so a revocation
//      takes effect immediately rather than at the end of a cache entry's life.
import type { ExternalSourceAdapter } from "@moss/module-sdk";

import { DatasetCache } from "./cache.js";
import type { DatasetLogger } from "./client.js";
import { createHostPinnedFetch, type HostPinnedFetchOptions } from "./host-pinning.js";

const NOOP_KEYED_LOGGER: DatasetLogger = { warn: () => undefined };

/**
 * The bounded transport shape a keyed source must declare. Deliberately structural: the concrete
 * publisher connection type lives in the owning module (News), and @moss/datasets must not
 * depend on a feature module to know how to fetch.
 */
export interface KeyedSourceDeclaration {
  readonly id: string;
  readonly fetchHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly minIntervalMs: number;
  readonly datasets: readonly { readonly key: string; readonly ttlMs: number }[];
}

export type KeyedCredentialFailureReason = "missing" | "revoked" | "unreadable";

export type KeyedCredentialLookupResult =
  | { readonly ok: true; readonly apiKey: string; readonly generation: string }
  | { readonly ok: false; readonly reason: KeyedCredentialFailureReason };

/**
 * How the runtime asks for the acting person's key. `credentialContext` is opaque here and is
 * handed straight back: News passes its request-scoped database handle through it, which is what
 * lets the cache outlive a single request while the lookup still runs under row security.
 *
 * SECURITY: an implementation must never put the key into a thrown error or a log line.
 */
export type KeyedCredentialLookup<C> = (input: {
  readonly actorUserId: string;
  readonly sourceId: string;
  readonly credentialContext: C;
}) => Promise<KeyedCredentialLookupResult>;

/** Thrown instead of fetching when the acting person has no usable key. Carries no key material. */
export class KeyedCredentialUnavailableError extends Error {
  constructor(readonly reason: KeyedCredentialFailureReason) {
    super(`keyed dataset credential unavailable: ${reason}`);
    this.name = "KeyedCredentialUnavailableError";
  }
}

export interface KeyedDatasetRequest<C> {
  readonly actorUserId: string;
  /** The row in the owning module's own table, not the connection id. */
  readonly sourceId: string;
  readonly datasetKey: string;
  readonly params: Record<string, unknown>;
  readonly credentialContext: C;
}

export interface KeyedDatasetEnvelope<T> {
  readonly data: T;
  readonly fetchedAt: string;
  readonly cached: boolean;
}

export interface KeyedDatasetClientDeps {
  readonly now?: () => Date;
  readonly maxEntriesPerSource?: number;
  readonly logger?: DatasetLogger;
  /** Test seam for asserting the declared bounds actually reach the pinned fetch. */
  readonly createFetch?: (
    hosts: readonly string[],
    options: HostPinnedFetchOptions
  ) => typeof fetch;
}

export interface KeyedDatasetClient<C> {
  getDataset<T>(request: KeyedDatasetRequest<C>): Promise<KeyedDatasetEnvelope<T>>;
}

/**
 * `connectionId:actorUserId:sourceId:generation:datasetKey:params`.
 *
 * Every dimension earns its place: the connection and dataset because one client could serve
 * several; the person and the source row because a keyed answer is private to one of each; the
 * generation because rotating or revoking a key must make every earlier answer unreachable
 * rather than merely expire it.
 */
function buildKeyedCacheKey(
  connectionId: string,
  actorUserId: string,
  sourceId: string,
  generation: string,
  datasetKey: string,
  params: Record<string, unknown>
): string {
  const serialized = Object.keys(params)
    .sort()
    .map((key) => `${key}=${JSON.stringify(params[key])}`)
    .join("&");
  return `${connectionId}:${actorUserId}:${sourceId}:${generation}:${datasetKey}:${serialized}`;
}

export function createKeyedDatasetClient<C>(
  declaration: KeyedSourceDeclaration,
  adapter: ExternalSourceAdapter,
  lookupCredential: KeyedCredentialLookup<C>,
  deps: KeyedDatasetClientDeps = {}
): KeyedDatasetClient<C> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? NOOP_KEYED_LOGGER;
  const cache = new DatasetCache({ maxEntries: deps.maxEntriesPerSource });
  const buildFetch = deps.createFetch ?? createHostPinnedFetch;
  const pinnedFetch = buildFetch(declaration.fetchHosts, {
    timeoutMs: declaration.timeoutMs,
    maxResponseBytes: declaration.maxResponseBytes
  });
  const datasetsByKey = new Map(declaration.datasets.map((dataset) => [dataset.key, dataset]));
  let lastFetchAtMs = 0;

  async function waitForRateCourtesy(): Promise<void> {
    if (!declaration.minIntervalMs) return;
    const remaining = declaration.minIntervalMs - (now().getTime() - lastFetchAtMs);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  return {
    async getDataset<T>(request: KeyedDatasetRequest<C>): Promise<KeyedDatasetEnvelope<T>> {
      const dataset = datasetsByKey.get(request.datasetKey);
      if (!dataset) {
        throw new Error(
          `Unknown dataset "${request.datasetKey}" for keyed source "${declaration.id}"`
        );
      }

      // Before the cache read, not after: a revoked key must stop being usable the moment it is
      // revoked, and a cache hit that skipped this would keep answering until the entry expired.
      const credential = await lookupCredential({
        actorUserId: request.actorUserId,
        sourceId: request.sourceId,
        credentialContext: request.credentialContext
      });
      if (!credential.ok) {
        // No user id and no key material: the outcome word is the whole story worth logging.
        logger.warn(
          {
            sourceId: declaration.id,
            datasetKey: request.datasetKey,
            outcome: "credential-unavailable",
            errorName: credential.reason
          },
          "keyed dataset call refused: no usable credential"
        );
        throw new KeyedCredentialUnavailableError(credential.reason);
      }

      const cacheKey = buildKeyedCacheKey(
        declaration.id,
        request.actorUserId,
        request.sourceId,
        credential.generation,
        request.datasetKey,
        request.params
      );
      const nowMs = now().getTime();
      const hit = cache.get<T>(cacheKey, nowMs);
      if (hit?.fresh) {
        return { data: hit.value, fetchedAt: new Date(nowMs).toISOString(), cached: true };
      }

      try {
        await waitForRateCourtesy();
        lastFetchAtMs = now().getTime();
        // The plaintext key reaches the adapter through this context and nowhere else: it is not
        // held on the client, not written to the cache, and not part of the cache key.
        const value = (await adapter.fetchDataset(request.datasetKey, request.params, {
          fetchFn: pinnedFetch,
          apiKey: credential.apiKey
        })) as T;
        const expiresAt = now().getTime() + dataset.ttlMs;
        // evictAt equals expiresAt: a keyed answer is never served stale. Degrading to an old
        // answer would hide an authentication failure behind yesterday's headlines.
        cache.set(cacheKey, value, expiresAt, expiresAt);
        return { data: value, fetchedAt: new Date().toISOString(), cached: false };
      } catch (error) {
        // Sanitized on purpose, same discipline as client.ts: no message, URL, headers or body.
        // An upstream error message can itself contain the URL the key was sent to.
        logger.warn(
          {
            sourceId: declaration.id,
            datasetKey: request.datasetKey,
            outcome: "fetch-failed",
            errorName: error instanceof Error ? error.name : typeof error
          },
          "keyed dataset fetch failed"
        );
        // Rethrown rather than degraded: the caller decides how to present a failure, and an
        // empty answer here would be indistinguishable from a quiet news day.
        throw error;
      }
    }
  };
}
