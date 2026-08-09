import type { ExternalSourceAdapter, ModuleExternalSourceManifest } from "@moss/module-sdk";

import { DatasetCache, DEFAULT_STALE_RETENTION_MS } from "./cache.js";
import {
  createHostPinnedFetch,
  HostPinnedFetchError,
  HostPinningViolationError
} from "./host-pinning.js";

/** Sanitized structured logging for dataset-runtime observability (never secrets/body). */
export interface DatasetLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

const NOOP_DATASET_LOGGER: DatasetLogger = {
  // Silent — production composition roots inject a real logger (server.log adapter). Noop
  // (not console) so a forgotten injection degrades quietly instead of spamming unstructured
  // console output (observability spec).
  warn: () => undefined
};

export interface DatasetEnvelope<T> {
  readonly data: T;
  /** True when this call served a fallback or a stale cache entry instead of a fresh fetch. */
  readonly degraded: boolean;
  readonly fetchedAt: string;
  /** Only set by `cacheOnly` reads: true when nothing (fresh or stale) was cached (#907). */
  readonly cacheMiss?: boolean;
}

export interface GetDatasetOptions<T> {
  readonly fallback: T;
  /**
   * Peek: report the cache without ever triggering a live fetch. Lets callers bound their own
   * fan-out (sports cross-league team search warm-fill, #907 spec §4.4).
   */
  readonly cacheOnly?: boolean;
}

export interface DatasetClient {
  getDataset<T>(
    datasetKey: string,
    params: Record<string, unknown>,
    options: GetDatasetOptions<T>
  ): Promise<DatasetEnvelope<T>>;
}

export interface DatasetClientDeps {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly maxEntriesPerSource?: number;
  readonly logger?: DatasetLogger;
  readonly fetchTimeoutMs?: number;
}

/**
 * Builds the instance-level cache key for one dataset call: `sourceId:datasetKey:params`. There
 * is no separate user dimension — safe today because every source is `credential: "none"`
 * (public, non-personalized data). **Constraint for future per-user sources:** the deferred
 * keyed-credential slice (connector-SDK spec Architecture §4) MUST ensure any per-user dataset's
 * `params` carries the user's identity (e.g. a `userId` field), or this instance-level cache will
 * serve one user's cached response to another purely by key collision (#836).
 */
function buildCacheKey(
  sourceId: string,
  datasetKey: string,
  params: Record<string, unknown>
): string {
  const serialized = Object.keys(params)
    .sort()
    .map((key) => `${key}=${JSON.stringify(params[key])}`)
    .join("&");
  return `${sourceId}:${datasetKey}:${serialized}`;
}

/**
 * Builds the runtime host for one declared `ModuleExternalSourceManifest`. Composition roots
 * construct one `DatasetClient` per declared source and pass it to the module's route/service
 * wiring — modules never construct their own fetch/cache plumbing (docs/superpowers/specs/
 * 2026-07-04-module-dataset-connector-sdk.md).
 *
 * `credential: "api-key"` is rejected here defensively; registration-time validation
 * (`assertModuleRegistryConsistency`) is the primary gate and should make this unreachable.
 */
export function createDatasetClient(
  source: ModuleExternalSourceManifest,
  adapter: ExternalSourceAdapter,
  deps: DatasetClientDeps = {}
): DatasetClient {
  if (source.credential === "api-key") {
    throw new Error(
      `External source "${source.id}" declares credential "api-key"; this slice does not build ` +
        "secret storage, and registration must reject it before createDatasetClient is reached."
    );
  }

  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? NOOP_DATASET_LOGGER;
  const cache = new DatasetCache({ maxEntries: deps.maxEntriesPerSource });
  const pinnedFetch = deps.fetchFn
    ? createHostPinnedFetch(source.fetchHosts, deps.fetchFn, deps.fetchTimeoutMs)
    : createHostPinnedFetch(source.fetchHosts, { timeoutMs: deps.fetchTimeoutMs });
  const datasetsByKey = new Map(source.datasets.map((dataset) => [dataset.key, dataset]));
  let lastFetchAtMs = 0;

  async function waitForRateCourtesy(): Promise<void> {
    const minIntervalMs = source.minIntervalMs;
    if (!minIntervalMs) return;
    const elapsed = now().getTime() - lastFetchAtMs;
    const remaining = minIntervalMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  return {
    async getDataset<T>(
      datasetKey: string,
      params: Record<string, unknown>,
      options: GetDatasetOptions<T>
    ): Promise<DatasetEnvelope<T>> {
      const dataset = datasetsByKey.get(datasetKey);
      if (!dataset) {
        throw new Error(`Unknown dataset "${datasetKey}" for external source "${source.id}"`);
      }

      const cacheKey = buildCacheKey(source.id, datasetKey, params);
      const nowMs = now().getTime();
      const hit = cache.get<T>(cacheKey, nowMs);
      if (options.cacheOnly) {
        // Peek path: never fetch. Stale-but-retained entries are served degraded, matching the
        // serve-stale semantics of the normal path (#907).
        if (hit) {
          return {
            data: hit.value,
            degraded: !hit.fresh,
            fetchedAt: new Date(nowMs).toISOString()
          };
        }
        return {
          data: options.fallback,
          degraded: false,
          cacheMiss: true,
          fetchedAt: new Date(nowMs).toISOString()
        };
      }
      if (hit && hit.fresh) {
        return { data: hit.value, degraded: false, fetchedAt: new Date(nowMs).toISOString() };
      }

      try {
        await waitForRateCourtesy();
        lastFetchAtMs = now().getTime();
        const value = (await adapter.fetchDataset(datasetKey, params, {
          fetchFn: pinnedFetch
        })) as T;
        const expiresAt = now().getTime() + dataset.ttlMs;
        const evictAt =
          dataset.staleness === "serve-stale-on-error"
            ? expiresAt + (dataset.staleRetentionMs ?? DEFAULT_STALE_RETENTION_MS)
            : expiresAt;
        cache.set(cacheKey, value, expiresAt, evictAt);
        return { data: value, degraded: false, fetchedAt: new Date().toISOString() };
      } catch (error) {
        if (error instanceof HostPinningViolationError) {
          logger.warn(
            { sourceId: source.id, datasetKey, host: error.host },
            "dataset host-pinning violation: blocked fetch outside allowed hosts"
          );
        } else {
          // Sanitized on purpose: no error.message, URL, headers, body, or credentials — only
          // the closed HostPinnedFetchError code and the error's class name ever reach the log
          // (#1433 — a total upstream outage previously produced zero log lines).
          logger.warn(
            {
              sourceId: source.id,
              datasetKey,
              outcome: hit ? "stale-cache" : "empty-fallback",
              errorName: error instanceof Error ? error.name : typeof error,
              ...(error instanceof HostPinnedFetchError ? { errorCode: error.code } : {})
            },
            "dataset fetch failed: serving degraded response"
          );
        }
        if (hit) {
          // Only reachable for serve-stale-on-error datasets: degrade-empty entries are deleted
          // by DatasetCache.get once past evictAt (which equals expiresAt for that policy), so
          // `hit` would already be undefined there.
          return { data: hit.value, degraded: true, fetchedAt: new Date(nowMs).toISOString() };
        }
        return { data: options.fallback, degraded: true, fetchedAt: new Date(nowMs).toISOString() };
      }
    }
  };
}
