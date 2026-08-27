export {
  createDatasetClient,
  type DatasetClient,
  type DatasetClientDeps,
  type DatasetEnvelope,
  type DatasetLogger,
  type GetDatasetOptions
} from "./client.js";
export {
  DatasetCache,
  DEFAULT_MAX_ENTRIES_PER_SOURCE,
  DEFAULT_STALE_RETENTION_MS
} from "./cache.js";
export type { DatasetCacheHit, DatasetCacheOptions } from "./cache.js";
export {
  assertValidFetchHosts,
  createHostPinnedFetch,
  DEFAULT_FETCH_TIMEOUT_MS,
  HostPinnedFetchError,
  HostPinningViolationError,
  isPinnableHost
} from "./host-pinning.js";
export {
  createKeyedDatasetClient,
  KeyedCredentialUnavailableError,
  type KeyedCredentialFailureReason,
  type KeyedCredentialLookup,
  type KeyedCredentialLookupResult,
  type KeyedDatasetClient,
  type KeyedDatasetClientDeps,
  type KeyedDatasetEnvelope,
  type KeyedDatasetRequest,
  type KeyedSourceDeclaration
} from "./keyed-client.js";
