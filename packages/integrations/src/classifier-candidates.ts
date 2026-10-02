import { CLASSIFIER_LIMITS, type ClassifierCandidate } from "@moss/module-sdk";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import {
  effectiveClassifierTools,
  type ClassifierConnectionState,
  type EligibleClassifierTool
} from "./classifier-settings.js";

/**
 * Candidate lists for connected tools (plan 2b.5, #2905).
 *
 * The classifier may offer a user's device names for an argument the owner reviewed as
 * `candidates`. A candidateSource names a discovered tool on the same connection that lists those
 * values. This module resolves that listing tool through the same reviewed eligibility rules as the
 * menu, calls it once on an explicit user-requested setup/refresh through an injected port (the
 * composition lane wires the port to the gateway's no-card path), extracts a bounded `{id,label}`
 * list with a code-authored mapping, and caches it owner-scoped with the listing tool's definition
 * fingerprint and a short expiry. The gate's hook only reads the cache; it never calls a tool, so a
 * message turn stays inside the shared deadline and shadow performs no candidate call.
 */

/** How long a fetched list may be served. An implementation bound, not a privacy permission. */
export const CANDIDATE_CACHE_TTL_MS = 300_000;

/** Most connections one cache retains; oldest fetch is dropped first. */
export const CANDIDATE_CACHE_MAX_ENTRIES = 200;

export interface CandidateListingRequest {
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly toolName: string;
  readonly signal: AbortSignal;
}

export type CandidateListingOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: "declined" | "unavailable" | "failed" };

/**
 * The one way a listing tool may be called. The runtime gate composition implements this over the
 * gateway's `callToolForGate` (`packages/ai/src/gateway/gateway.ts:217-266`) so the call inherits
 * membership, input validation and policy, and a call that would need confirmation is declined
 * before any handler runs. It is never implemented over `mcp-client.ts` or `openapi-invoke.ts`
 * directly.
 */
export interface CandidateListingPort {
  callReadOnlyListingTool(request: CandidateListingRequest): Promise<CandidateListingOutcome>;
}

export interface CandidateCacheKey {
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly sourceName: string;
}

export interface CachedCandidateList {
  readonly candidates: readonly ClassifierCandidate[];
  readonly sourceFingerprint: string;
  readonly fetchedAt: number;
}

export interface CandidateCache {
  get(key: CandidateCacheKey): CachedCandidateList | undefined;
  set(key: CandidateCacheKey, value: CachedCandidateList): void;
  drop(key: CandidateCacheKey): void;
  /** Called from the existing per-connection invalidation points (edit, refresh, delete, opt-out). */
  dropConnection(ownerUserId: string, connectionId: string): void;
  clear(): void;
}

export interface CandidateCacheDeps {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

function cacheKey(ownerUserId: string, connectionId: string, sourceName: string): string {
  return `${ownerUserId}\u0000${connectionId}\u0000${sourceName}`;
}

/**
 * In-memory owner-scoped cache. A key always includes the owner, and `dropConnection` only ever
 * clears one owner's connection, so two users can never share a candidate list. Entries past the
 * TTL are removed on read; over the entry cap the oldest fetch is evicted first so one connection
 * cannot grow the cache without limit.
 */
export function createCandidateCache(deps: CandidateCacheDeps = {}): CandidateCache {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? CANDIDATE_CACHE_TTL_MS;
  const maxEntries = deps.maxEntries ?? CANDIDATE_CACHE_MAX_ENTRIES;
  const entries = new Map<string, { key: CandidateCacheKey; value: CachedCandidateList }>();

  function evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.value.fetchedAt < oldestAt) {
        oldestAt = entry.value.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
  }

  return {
    get(key) {
      const keyString = cacheKey(key.ownerUserId, key.connectionId, key.sourceName);
      const entry = entries.get(keyString);
      if (!entry) return undefined;
      if (now() - entry.value.fetchedAt > ttlMs) {
        entries.delete(keyString);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      const keyString = cacheKey(key.ownerUserId, key.connectionId, key.sourceName);
      entries.delete(keyString);
      entries.set(keyString, { key, value });
      while (entries.size > maxEntries) evictOldest();
    },
    drop(key) {
      entries.delete(cacheKey(key.ownerUserId, key.connectionId, key.sourceName));
    },
    dropConnection(ownerUserId, connectionId) {
      const prefix = `${ownerUserId}\u0000${connectionId}\u0000`;
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) entries.delete(key);
      }
    },
    clear() {
      entries.clear();
    }
  };
}

/** Module-level singleton consumed by `tool-manifests.ts`; dropped from the existing route edits. */
export const candidateCache: CandidateCache = createCandidateCache();

/**
 * The reviewed read-only listing tool a candidateSource names, or null.
 *
 * This reuses `effectiveClassifierTools`, so the same fail-closed rules that keep a tool out of the
 * menu keep it out of the candidate path: connection enabled, classifier switch on, no discovery
 * error, still discovered, ordinary-chat enabled, a saved review with `optIn:true`,
 * `reviewedRisk:"read"` and a current fingerprint. A server `readOnly` hint alone never qualifies.
 */
export function resolveCandidateListingTool(
  state: ClassifierConnectionState,
  sourceName: string
): EligibleClassifierTool | null {
  if (sourceName === "") return null;
  return (
    effectiveClassifierTools(state).find(
      (entry) => entry.tool.name === sourceName && entry.risk === "read"
    ) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function isBounded(value: string, max: number): boolean {
  return value.length <= max;
}

/** One listing entry to `{id,label}`, or null. Accepts a bare name string or a small object shape. */
function normalizeListingEntry(entry: unknown): ClassifierCandidate | null {
  if (typeof entry === "string") {
    if (entry.trim() === "" || entry.length > CLASSIFIER_LIMITS.idChars) return null;
    return { id: entry, label: entry };
  }
  if (!isRecord(entry)) return null;
  // Only these names are remembered from a listing result. A result that carries a secret, a
  // default/example value or any other field never has it copied into a label.
  const id = firstString(entry.id, entry.entity_id);
  const label = firstString(entry.label, entry.name, entry.friendly_name);
  if (id === null || label === null) return null;
  if (
    !isBounded(id, CLASSIFIER_LIMITS.idChars) ||
    !isBounded(label, CLASSIFIER_LIMITS.labelChars)
  ) {
    return null;
  }
  return { id, label };
}

/**
 * The code-authored extraction mapping. Accepts an `ok` integration envelope whose `detail` is an
 * array, or a bare array, and projects each entry to `{id,label}`. The list is rejected whole —
 * never truncated — when it is empty, over the candidate cap, has a missing/malformed entry, or has
 * a duplicate id or label (an ambiguous name must not be offered). Returns null on any violation.
 */
export function extractCandidatesFromListing(
  result: unknown
): readonly ClassifierCandidate[] | null {
  let list: unknown;
  if (Array.isArray(result)) {
    list = result;
  } else if (isRecord(result)) {
    if ("status" in result && result.status !== "ok") return null;
    list = result.detail;
  } else {
    return null;
  }
  if (!Array.isArray(list)) return null;
  if (list.length === 0 || list.length > CLASSIFIER_LIMITS.candidates) return null;

  const candidates: ClassifierCandidate[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const entry of list) {
    const candidate = normalizeListingEntry(entry);
    if (!candidate) return null;
    if (ids.has(candidate.id) || labels.has(candidate.label)) return null;
    ids.add(candidate.id);
    labels.add(candidate.label);
    candidates.push(candidate);
  }
  return candidates;
}

export interface RefreshCandidatesInput {
  readonly state: ClassifierConnectionState;
  readonly connectionId: string;
  readonly actorUserId: string;
  readonly sourceName: string;
  readonly port: CandidateListingPort;
  readonly cache: CandidateCache;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}

export interface RefreshCandidatesResult {
  readonly refreshed: boolean;
  readonly reason?: string;
}

/**
 * One explicit user-requested refresh of a connection's candidate list. Resolves the listing tool
 * through the reviewed rules, calls it once through the port, and caches only a fully usable list.
 * Any non-executed outcome, thrown error or unusable list drops the cached entry, so a failure can
 * never leave a stale list in place.
 */
export async function refreshConnectionCandidates(
  input: RefreshCandidatesInput
): Promise<RefreshCandidatesResult> {
  const listing = resolveCandidateListingTool(input.state, input.sourceName);
  if (!listing) return { refreshed: false, reason: "no_read_only_listing_tool" };

  const key: CandidateCacheKey = {
    ownerUserId: input.actorUserId,
    connectionId: input.connectionId,
    sourceName: input.sourceName
  };
  const signal = input.signal ?? new AbortController().signal;

  let outcome: CandidateListingOutcome;
  try {
    outcome = await input.port.callReadOnlyListingTool({
      actorUserId: input.actorUserId,
      connectionId: input.connectionId,
      toolName: listing.tool.name,
      signal
    });
  } catch {
    input.cache.drop(key);
    return { refreshed: false, reason: "listing_failed" };
  }

  if (!outcome.ok) {
    input.cache.drop(key);
    return { refreshed: false, reason: outcome.reason };
  }

  const candidates = extractCandidatesFromListing(outcome.result);
  if (!candidates) {
    input.cache.drop(key);
    return { refreshed: false, reason: "unusable_listing" };
  }

  input.cache.set(key, {
    candidates,
    sourceFingerprint: toolDefinitionFingerprint(listing.tool),
    fetchedAt: input.now()
  });
  return { refreshed: true };
}

export interface LoadCandidatesInput {
  readonly cache: CandidateCache;
  readonly actorUserId: string;
  readonly connectionId: string;
  readonly sourceName: string;
  /** The listing tool's current definition fingerprint; a mismatch means stale. */
  readonly sourceFingerprint: string;
}

/**
 * The gate hook's read. Returns the cached list only for the same owner, a current listing
 * fingerprint, and an unexpired entry; otherwise null, which the tool treats as
 * `candidates_unavailable` and excludes the tool.
 */
export function loadCachedCandidates(
  input: LoadCandidatesInput
): readonly ClassifierCandidate[] | null {
  const entry = input.cache.get({
    ownerUserId: input.actorUserId,
    connectionId: input.connectionId,
    sourceName: input.sourceName
  });
  if (!entry) return null;
  if (entry.sourceFingerprint !== input.sourceFingerprint) return null;
  return entry.candidates;
}
