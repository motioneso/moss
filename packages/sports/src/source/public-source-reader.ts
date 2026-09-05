import { createHash } from "node:crypto";

import { DatasetCache, DEFAULT_STALE_RETENTION_MS } from "@moss/datasets";
import type { AccessContext, DataContextDb } from "@moss/db";
import { isPublicFeedDocument, parsePublicFeedItems } from "@moss/news";

import { catalogEntry } from "./catalog.js";
import type { SportsSafeFetchPort, SportsWebRequestHop } from "./discovery.js";
import {
  type EnsurePhotoResult,
  type PhotoHostSlot,
  type SportsPhotoStore,
  type StoredPhoto
} from "./photo-store.js";
import { attachSportsPhotoUrls } from "./photo-pass.js";
import { recordSportsPhotoOutcome } from "./photo-storage.js";
import type { SportsPhotoOutcome } from "./photo-status.js";
import {
  expandSportsSourceRecipe,
  extractSportsSourceRecipe,
  validateSportsSourceRecipe,
  type SportsRecipeItem,
  type SportsSourceRecipe
} from "./recipe.js";
import {
  SportsSourcesRepository,
  type SportsRuntimeSource,
  type SportsRuntimeTargetResult
} from "./repository.js";
import {
  parseRedditFeed,
  REDDIT_ACCEPT_HEADERS,
  REDDIT_CONTENT_TYPES,
  REDDIT_RATE_LIMIT_MESSAGE,
  REDDIT_USER_AGENT,
  redditHopGuard
} from "./reddit.js";
import type { CustomSourceHeadline } from "./sports-source.js";
import { SPORTS_SPORT_LABELS } from "./scope.js";

const MAX_ASSIGNMENTS = 20;
const MAX_REQUESTS = 30;
const MAX_CONCURRENCY = 4;
const MAX_DOMAIN_CONCURRENCY = 2;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const FETCH_TIMEOUT_MS = 6_000;
const REFRESH_DEADLINE_MS = 12_000;
const MAX_RETRY_AFTER_MS = 5_000;
const HEADLINE_TTL_MS = 10 * 60 * 1000;

export type SportsPublicSourceHeadline = CustomSourceHeadline & {
  readonly imageUrl: string | null;
  readonly sportKey: SportsRuntimeSource["assignments"][number]["scope"]["sportKey"];
};

/** #2237 the deterministic photo pass' budget, per source, per refresh. */
/** The same margin the photo store applies to its own download, so the two cannot drift apart. */
/** A failed photo is not retried for as long as its story could still be served from the cache. */
const PHOTO_FAILURE_TTL_MS = HEADLINE_TTL_MS + DEFAULT_STALE_RETENTION_MS;
const PHOTO_FAILURE_MAX_ENTRIES = 2_000;

/** Newlines cannot occur in a user id, a source id or a URL, so this join is unambiguous. */
function photoFailureKey(actorUserId: string, sourceId: string, photoUrl: string): string {
  return `${actorUserId}\n${sourceId}\n${photoUrl}`;
}

interface ReaderDataContext {
  withDataContext<T>(
    accessContext: AccessContext,
    work: (scopedDb: DataContextDb) => Promise<T>
  ): Promise<T>;
}

interface PublicSourceReaderDependencies {
  readonly dataContext: ReaderDataContext;
  readonly repository?: SportsSourcesRepository;
  readonly fetch: SportsSafeFetchPort;
  /** #2237 omitted in tests that do not exercise photos; the pass is skipped entirely then. */
  readonly photos?: SportsPhotoStore;
  readonly cache?: DatasetCache;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface SportsPublicSourceRefreshResult {
  readonly headlines: readonly SportsPublicSourceHeadline[];
  readonly degraded: boolean;
  readonly persistedResults: number;
}

export interface RequestAssignment {
  readonly source: SportsRuntimeSource;
  readonly assignment: SportsRuntimeSource["assignments"][number];
}

export interface RequestGroup {
  readonly identity: string;
  /** #2211 a subreddit feed is parsed as Reddit Atom, everything else as a feed or recipe. */
  readonly kind: "feed" | "scrape" | "reddit";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly allowedContentTypes: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly recipe: SportsSourceRecipe | null;
  readonly assignments: RequestAssignment[];
}

export interface ExtractedHeadline {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly summary: string;
  /** #2211 set for a subreddit's linked article: the real publisher, not the subreddit. */
  readonly publisherLabel?: string;
  readonly publisherDomain?: string;
  /**
   * #2237 the publisher's own photo URL, never a per-owner key: this item is cached across every
   * owner who follows the same source, so an owner-specific value here would leak between vaults.
   */
  readonly photoUrl?: string | null;
}

interface RequestOutcome {
  readonly items: readonly ExtractedHeadline[];
  readonly state: SportsRuntimeTargetResult["healthState"];
  readonly reason: string | null;
  readonly message: string | null;
  readonly checkedAt: Date | null;
  readonly fromCache: boolean;
}

export class DomainConcurrencyLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async acquireAll(
    hosts: readonly string[],
    deadline: number,
    now: () => number,
    signal?: AbortSignal
  ): Promise<readonly string[] | null> {
    const acquired: string[] = [];
    for (const host of [...new Set(hosts.map((value) => value.toLowerCase()))].sort()) {
      if (!(await this.acquire(host, deadline, now, signal))) {
        for (const held of acquired.reverse()) this.release(held);
        return null;
      }
      acquired.push(host);
    }
    return acquired;
  }

  private async acquire(
    host: string,
    deadline: number,
    now: () => number,
    signal?: AbortSignal
  ): Promise<boolean> {
    if ((this.active.get(host) ?? 0) < MAX_DOMAIN_CONCURRENCY) {
      this.active.set(host, (this.active.get(host) ?? 0) + 1);
      return true;
    }
    if (signal?.aborted || now() >= deadline) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const queue = this.waiters.get(host) ?? [];
      const grant = (): void => finish(true);
      const finish = (granted: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const current = this.waiters.get(host);
        const index = current?.indexOf(grant) ?? -1;
        if (current && index >= 0) current.splice(index, 1);
        if (current?.length === 0) this.waiters.delete(host);
        if (granted) this.active.set(host, (this.active.get(host) ?? 0) + 1);
        resolve(granted);
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(1, deadline - now()));
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(grant);
      this.waiters.set(host, queue);
    });
  }

  release(host: string): void {
    const count = this.active.get(host) ?? 0;
    if (count <= 1) this.active.delete(host);
    else this.active.set(host, count - 1);
    const next = this.waiters.get(host)?.shift();
    if (this.waiters.get(host)?.length === 0) this.waiters.delete(host);
    next?.();
  }
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function retryDelay(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = /^\d{1,3}$/.test(value) ? Number(value) : null;
  const milliseconds = seconds === null ? Date.parse(value) - now : seconds * 1000;
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_RETRY_AFTER_MS
    ? milliseconds
    : null;
}

function failureState(
  failure: { readonly reason: string; readonly status?: number },
  budgetDenied: boolean,
  kind: RequestGroup["kind"] = "feed"
): Pick<RequestOutcome, "state" | "reason" | "message"> {
  if (budgetDenied) {
    return {
      state: "failing",
      reason: "request_budget_exceeded",
      message: "The source request budget was exhausted."
    };
  }
  if (failure.status === 401 || failure.status === 403) {
    return {
      state: "auth_required",
      reason: "auth_required",
      message: "This publisher requires authentication."
    };
  }
  if (failure.status === 429 || failure.reason === "rate_limited") {
    return {
      state: "failing",
      reason: "rate_limited",
      message:
        kind === "reddit" ? REDDIT_RATE_LIMIT_MESSAGE : "The publisher asked Moss to retry later."
    };
  }
  if (failure.reason === "blocked" || failure.reason === "not_https") {
    return {
      state: "unsupported",
      reason: "unsafe_or_unsupported_target",
      message: "The source target did not pass the public-source safety checks."
    };
  }
  return {
    state: "failing",
    reason: failure.reason === "timeout" ? "timeout" : "upstream_unavailable",
    message:
      failure.reason === "timeout"
        ? "The publisher did not respond in time."
        : "The publisher could not be refreshed."
  };
}

function recipeItems(items: readonly SportsRecipeItem[], requestUrl: string): ExtractedHeadline[] {
  return items.map((item) => {
    const url = item.url ?? requestUrl;
    return {
      id: stableId(`${url}\0${item.headline}`),
      title: item.headline,
      url,
      publishedAt: item.publishedAt ?? null,
      summary: ""
    };
  });
}

function publicHeadlines(
  pair: RequestAssignment,
  items: readonly ExtractedHeadline[],
  checkedAt: Date | null,
  photos: ReadonlyMap<string, StoredPhoto> = new Map()
): SportsPublicSourceHeadline[] {
  const { source, assignment } = pair;
  const competitionKey = assignment.scope.kind === "sport" ? null : assignment.scope.competitionKey;
  const fallbackTime = (checkedAt ?? new Date(0)).toISOString();
  return items.map((item) => {
    const headlineId = `${source.id}:${item.id}`;
    const photo = photos.get(item.id) ?? null;
    return {
      origin: "custom" as const,
      sourceId: source.id,
      id: headlineId,
      sportKey: assignment.scope.sportKey,
      competitionKey,
      competitionLabel:
        assignment.scope.kind === "sport"
          ? SPORTS_SPORT_LABELS[assignment.scope.sportKey]
          : (catalogEntry(assignment.scope.competitionKey)?.label ??
            assignment.scope.competitionKey),
      title: item.title,
      url: item.url,
      publishedAt: item.publishedAt ?? fallbackTime,
      imageUrl: photo ? `/api/sports/headlines/${encodeURIComponent(headlineId)}/photo` : null,
      imageWidth: photo?.width ?? null,
      imageHeight: photo?.height ?? null,
      summary: item.summary,
      teamKeys: assignment.scope.kind === "team" ? [assignment.scope.teamKey] : [],
      publisherLabel: item.publisherLabel ?? source.label,
      publisherDomain: item.publisherDomain ?? source.canonicalDomain
    };
  });
}

export class SportsPublicSourceReader {
  private readonly repository: SportsSourcesRepository;
  private readonly cache: DatasetCache;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Photo attempt key to the time its "do not retry" memory expires. Insertion-ordered. */
  private readonly photoFailures = new Map<string, number>();

  constructor(private readonly dependencies: PublicSourceReaderDependencies) {
    this.repository = dependencies.repository ?? new SportsSourcesRepository();
    this.cache = dependencies.cache ?? new DatasetCache({ maxEntries: 500 });
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
  }

  /**
   * Downloads and stores each story's photo into this owner's vault, then records which stored
   * copy each headline id serves. Returns the copies keyed by feed item id.
   */
  private isRememberedPhotoFailure(key: string): boolean {
    const expiresAt = this.photoFailures.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.now()) return true;
    this.photoFailures.delete(key);
    return false;
  }

  private rememberPhotoFailure(key: string): void {
    this.photoFailures.delete(key);
    this.photoFailures.set(key, this.now() + PHOTO_FAILURE_TTL_MS);
    while (this.photoFailures.size > PHOTO_FAILURE_MAX_ENTRIES) {
      const oldest = this.photoFailures.keys().next();
      if (oldest.done) break;
      this.photoFailures.delete(oldest.value);
    }
  }

  private async storePhotos(
    accessContext: AccessContext,
    pair: RequestAssignment,
    items: readonly ExtractedHeadline[],
    deadline: number,
    domainLimiter: DomainConcurrencyLimiter,
    signal?: AbortSignal
  ): Promise<Map<string, StoredPhoto>> {
    const stored = new Map<string, StoredPhoto>();
    const photos = this.dependencies.photos;
    if (!photos) return stored;
    // The same limiter the article page fetches use, so a publisher never sees more than two of
    // our requests at once whichever kind of request they are.
    const hostSlot: PhotoHostSlot = {
      acquire: async (host) =>
        (await domainLimiter.acquireAll([host], deadline, this.now, signal)) !== null,
      release: (host) => domainLimiter.release(host.toLowerCase())
    };
    for (const item of items) {
      // Past the deadline every remaining story is certain to be skipped, and each call still
      // does folder and file work before reaching the store's own check, so stop here instead.
      // The margin is deliberately not applied: inside it a copy we already hold is still worth
      // returning, and that costs no network.
      if (signal?.aborted || deadline - this.now() <= 0) break;
      if (!item.photoUrl) continue;
      // A photo that already failed is not tried again while the story is still cached: without
      // this, a permanently broken image is re-downloaded on every single refresh.
      const failureKey = photoFailureKey(accessContext.actorUserId, pair.source.id, item.photoUrl);
      if (this.isRememberedPhotoFailure(failureKey)) continue;
      let result: EnsurePhotoResult;
      try {
        result = await photos.ensure(accessContext, pair.source.id, item.photoUrl, {
          ...(signal ? { signal } : {}),
          remainingMs: () => deadline - this.now(),
          hostSlot
        });
      } catch {
        result = { outcome: "unusable" };
      }
      // Only a photo we actually learned something bad about is remembered. Running out of
      // refresh time teaches us nothing, so that photo is tried again on the next refresh.
      if (result.outcome === "unusable") {
        this.rememberPhotoFailure(failureKey);
        continue;
      }
      if (result.outcome === "skipped") continue;
      stored.set(item.id, result.photo);
      photos.linkHeadline(
        accessContext.actorUserId,
        `${pair.source.id}:${item.id}`,
        result.photo.key
      );
    }
    return stored;
  }

  async refresh(
    accessContext: AccessContext,
    options: {
      readonly sourceId?: string;
      readonly bypassCache?: boolean;
      readonly signal?: AbortSignal;
    } = {}
  ): Promise<SportsPublicSourceRefreshResult> {
    const sources = await this.dependencies.dataContext.withDataContext(accessContext, (db) =>
      this.repository.listRuntimeSources(db, options.sourceId)
    );
    const allAssignments = sources.flatMap((source) =>
      source.assignments
        .filter((assignment) => assignment.previewStatus === "verified")
        .map((assignment) => ({ source, assignment }))
    );
    const activeAssignments = allAssignments.slice(0, MAX_ASSIGNMENTS);
    const results: SportsRuntimeTargetResult[] = allAssignments
      .slice(MAX_ASSIGNMENTS)
      .map(({ source, assignment }) => ({
        sourceId: source.id,
        assignmentId: assignment.id,
        runtimeFingerprint: source.runtimeFingerprint,
        targetUrl: assignment.targetUrl,
        targetParameters: assignment.targetParameters,
        healthState: "failing",
        healthReasonCode: "assignment_limit_exceeded",
        healthMessage: "The custom-source assignment limit was exceeded.",
        checkedAt: null
      }));
    const groups = new Map<string, RequestGroup>();

    const failWithoutFetch = (
      pair: RequestAssignment,
      reason: "recipe_missing" | "recipe_drift" | "invalid_target",
      message: string
    ): void => {
      degraded = true;
      results.push({
        sourceId: pair.source.id,
        assignmentId: pair.assignment.id,
        runtimeFingerprint: pair.source.runtimeFingerprint,
        targetUrl: pair.assignment.targetUrl,
        targetParameters: pair.assignment.targetParameters,
        healthState: "failing",
        healthReasonCode: reason,
        healthMessage: message,
        checkedAt: null
      });
    };

    let degraded = results.some((result) => result.healthState !== "healthy");

    for (const pair of activeAssignments) {
      const { source, assignment } = pair;
      if (!source.enabled) {
        results.push({
          sourceId: source.id,
          assignmentId: assignment.id,
          runtimeFingerprint: source.runtimeFingerprint,
          targetUrl: assignment.targetUrl,
          targetParameters: assignment.targetParameters,
          healthState: "disabled",
          healthReasonCode: null,
          healthMessage: null,
          checkedAt: null
        });
        continue;
      }
      let group: Omit<RequestGroup, "assignments">;
      if (source.retrievalMethod === "reddit" && source.feedUrl) {
        group = {
          identity: stableId(`${source.runtimeFingerprint}\0${source.feedUrl}`),
          kind: "reddit",
          url: source.feedUrl,
          headers: REDDIT_ACCEPT_HEADERS,
          allowedContentTypes: REDDIT_CONTENT_TYPES,
          allowedHosts: source.confirmedFetchHosts,
          recipe: null
        };
      } else if (source.retrievalMethod === "feed" && source.feedUrl) {
        group = {
          identity: stableId(`${source.runtimeFingerprint}\0${source.feedUrl}`),
          kind: "feed",
          url: source.feedUrl,
          headers: {
            accept:
              "application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.9"
          },
          allowedContentTypes: [
            "application/rss+xml",
            "application/atom+xml",
            "application/xml",
            "text/xml",
            "text/plain"
          ],
          allowedHosts: source.confirmedFetchHosts,
          recipe: null
        };
      } else {
        const validated = validateSportsSourceRecipe(source.recipeJson);
        if (!validated.ok) {
          failWithoutFetch(
            pair,
            source.recipeJson === null ? "recipe_missing" : "recipe_drift",
            source.recipeJson === null
              ? "Rebuild this source recipe before refreshing."
              : "The saved source recipe is no longer valid."
          );
          continue;
        }
        if (validated.fingerprint !== source.runtimeFingerprint) {
          failWithoutFetch(pair, "recipe_drift", "The saved source recipe fingerprint changed.");
          continue;
        }
        const parameters = Object.fromEntries(
          Object.entries(assignment.targetParameters).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        );
        const expanded = expandSportsSourceRecipe(validated.recipe, parameters);
        if (!expanded.ok) {
          failWithoutFetch(pair, "invalid_target", "The saved source target is no longer valid.");
          continue;
        }
        group = {
          identity: expanded.identity,
          kind: "scrape",
          url: expanded.url,
          headers: expanded.headers,
          allowedContentTypes:
            validated.recipe.kind === "json"
              ? ["application/json", "text/json"]
              : ["text/html", "application/xhtml+xml"],
          allowedHosts: validated.recipe.fetchHosts,
          recipe: validated.recipe
        };
      }
      const existing = groups.get(group.identity);
      if (existing) existing.assignments.push(pair);
      else groups.set(group.identity, { ...group, assignments: [pair] });
    }

    const headlines: SportsPublicSourceHeadline[] = [];
    let requestCount = 0;
    const deadline = this.now() + REFRESH_DEADLINE_MS;
    const domainLimiter = new DomainConcurrencyLimiter();
    const pageBudget = new Map<string, number>();
    const keptPhotoKeys = new Set<string>();
    /**
     * The photo hunt is deliberately held back until every source has its headlines. Sharing one
     * four-at-a-time budget between the two meant a source whose photos were slow could hold a
     * slot long enough for an unrelated healthy source never to be fetched at all, which turned a
     * photo problem into missing headlines for somebody else.
     */
    const photoPhase: Array<{
      readonly group: RequestGroup;
      readonly outcome: RequestOutcome;
      readonly feedBody: string | null;
      /** A cache hit that was already photo-hunted and cached: do neither again. */
      readonly reuseCached: boolean;
    }> = [];

    const runAll = async (tasks: ReadonlyArray<() => Promise<void>>): Promise<void> => {
      const queue = [...tasks];
      const running = new Set<Promise<void>>();
      while (queue.length > 0 || running.size > 0) {
        let scheduled = false;
        while (running.size < MAX_CONCURRENCY) {
          const task = queue.shift();
          if (!task) break;
          const promise = task().finally(() => {
            running.delete(promise);
          });
          running.add(promise);
          scheduled = true;
        }
        if (running.size > 0 && (!scheduled || running.size >= MAX_CONCURRENCY)) {
          await Promise.race(running);
        }
      }
    };

    /** Returns how many of the pushed headlines are served with a stored photo. */
    const pushHeadlines = async (
      pair: RequestAssignment,
      items: readonly ExtractedHeadline[],
      checkedAt: Date | null
    ): Promise<number> => {
      const stored = await this.storePhotos(
        accessContext,
        pair,
        items,
        deadline,
        domainLimiter,
        options.signal
      );
      for (const copy of stored.values()) keptPhotoKeys.add(copy.key);
      headlines.push(...publicHeadlines(pair, items, checkedAt, stored));
      return stored.size;
    };

    const run = async (group: RequestGroup): Promise<void> => {
      const cacheHit = options.bypassCache
        ? undefined
        : this.cache.get<readonly ExtractedHeadline[]>(group.identity, this.now());
      if (cacheHit?.fresh) {
        photoPhase.push({
          group,
          outcome: {
            items: cacheHit.value,
            state: "healthy",
            reason: null,
            message: null,
            checkedAt: null,
            fromCache: true
          },
          feedBody: null,
          reuseCached: true
        });
        return;
      }
      let budgetDenied = false;
      const heldDomains = await domainLimiter.acquireAll(
        group.allowedHosts,
        deadline,
        this.now,
        options.signal
      );
      if (!heldDomains) {
        degraded = true;
        for (const pair of group.assignments) {
          results.push({
            sourceId: pair.source.id,
            assignmentId: pair.assignment.id,
            runtimeFingerprint: pair.source.runtimeFingerprint,
            targetUrl: pair.assignment.targetUrl,
            targetParameters: pair.assignment.targetParameters,
            healthState: "failing",
            healthReasonCode: "concurrency_timeout",
            healthMessage: "The source could not start before the refresh deadline.",
            checkedAt: null
          });
        }
        return;
      }
      const redditGuard = group.kind === "reddit" ? redditHopGuard(group.url) : null;
      const beforeRequest = async (hop: SportsWebRequestHop): Promise<boolean> => {
        if (options.signal?.aborted || requestCount >= MAX_REQUESTS) {
          budgetDenied = requestCount >= MAX_REQUESTS;
          return false;
        }
        if (hop.url.port || !group.allowedHosts.includes(hop.url.hostname.toLowerCase())) {
          return false;
        }
        if (redditGuard && !redditGuard(hop)) return false;
        requestCount += 1;
        return true;
      };
      const fetchOnce = () =>
        this.dependencies.fetch(group.url, {
          allowedHosts: group.allowedHosts,
          requestHeaders: group.headers,
          allowedContentTypes: group.allowedContentTypes,
          beforeRequest,
          maxBytes: MAX_RESPONSE_BYTES,
          rejectOversizedResponses: true,
          timeoutMs: Math.min(FETCH_TIMEOUT_MS, Math.max(1, deadline - this.now())),
          ...(group.kind === "reddit" ? { userAgent: REDDIT_USER_AGENT } : {}),
          signal: options.signal
        });
      let response: Awaited<ReturnType<SportsSafeFetchPort>>;
      try {
        response = await fetchOnce();
        if (!response.ok && response.status === 429) {
          const delay = retryDelay(response.retryAfter, this.now());
          if (
            delay !== null &&
            requestCount < MAX_REQUESTS &&
            this.now() + delay < deadline &&
            !options.signal?.aborted
          ) {
            await this.sleep(delay, options.signal);
            if (!options.signal?.aborted) response = await fetchOnce();
          }
        }
      } finally {
        for (const host of heldDomains) domainLimiter.release(host);
      }
      if (options.signal?.aborted) {
        degraded = true;
        return;
      }
      const checkedAt = budgetDenied ? null : new Date(this.now());
      let outcome: RequestOutcome;
      if (!response.ok) {
        const failure = failureState(response, budgetDenied, group.kind);
        outcome = {
          items: cacheHit?.value ?? [],
          ...failure,
          checkedAt,
          fromCache: false
        };
      } else if (group.recipe) {
        const extracted = extractSportsSourceRecipe(group.recipe, {
          body: response.body,
          contentType: response.contentType,
          requestUrl: response.finalUrl
        });
        outcome = extracted.ok
          ? {
              items: recipeItems(extracted.items, response.finalUrl),
              state: "healthy",
              reason: null,
              message: null,
              checkedAt,
              fromCache: false
            }
          : {
              items: cacheHit?.value ?? [],
              state: extracted.reason === "recipe_drift" ? "failing" : "unsupported",
              reason: extracted.reason,
              message:
                extracted.reason === "recipe_drift"
                  ? "The publisher changed the structure used by this source."
                  : "The publisher returned an unsupported response.",
              checkedAt,
              fromCache: false
            };
      } else if (group.kind === "reddit") {
        const listing = parseRedditFeed(response.body, "");
        outcome = listing.ok
          ? {
              items: listing.feed.headlines.map((headline) => ({
                id: stableId(headline.url),
                title: headline.title,
                url: headline.url,
                publishedAt: headline.publishedAt,
                summary: "",
                publisherLabel: headline.publisherLabel,
                publisherDomain: headline.publisherDomain
              })),
              state: "healthy",
              reason: null,
              message: null,
              checkedAt,
              fromCache: false
            }
          : {
              items: cacheHit?.value ?? [],
              state: "unsupported",
              reason: "unsupported_response",
              message: "Reddit did not return a readable post feed.",
              checkedAt,
              fromCache: false
            };
      } else if (!isPublicFeedDocument(response.body)) {
        outcome = {
          items: cacheHit?.value ?? [],
          state: "unsupported",
          reason: "unsupported_response",
          message: "The publisher did not return a supported RSS or Atom feed.",
          checkedAt,
          fromCache: false
        };
      } else {
        const items = parsePublicFeedItems(response.body).map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt,
          summary: item.summary
        }));
        outcome = {
          items,
          state: "healthy",
          reason: null,
          message: null,
          checkedAt,
          fromCache: false
        };
      }
      if (outcome.state === "healthy" && outcome.checkedAt) {
        const fetchedAt = outcome.checkedAt.toISOString();
        outcome = {
          ...outcome,
          items: outcome.items.map((item) =>
            item.publishedAt ? item : { ...item, publishedAt: fetchedAt }
          )
        };
      }
      if (outcome.state !== "healthy") degraded = true;
      photoPhase.push({
        group,
        outcome,
        feedBody: group.kind === "feed" && response.ok ? response.body : null,
        reuseCached: false
      });
    };

    // What each source's stories actually got this time round. A photo counts only once its
    // download succeeded and the returned story is served with it: a candidate address in the
    // feed says nothing until the store accepts it. Only a refresh that really went out and
    // really had stories counts: a cached answer says nothing new about photos.
    const photoOutcomes = new Map<string, SportsPhotoOutcome>();
    const finish = async (entry: (typeof photoPhase)[number]): Promise<void> => {
      let items = entry.outcome.items;
      if (!entry.reuseCached && entry.outcome.state === "healthy") {
        if (this.dependencies.photos) {
          items = await attachSportsPhotoUrls(entry.group, items, entry.feedBody, {
            deadline,
            signal: options.signal,
            domainLimiter,
            pageBudget,
            now: this.now,
            fetch: this.dependencies.fetch
          });
        }
        const cachedAt = this.now();
        this.cache.set(
          entry.group.identity,
          items,
          cachedAt + HEADLINE_TTL_MS,
          cachedAt + HEADLINE_TTL_MS + DEFAULT_STALE_RETENTION_MS
        );
      }
      const countsForPhotos =
        this.dependencies.photos !== undefined &&
        !entry.outcome.fromCache &&
        entry.outcome.state === "healthy" &&
        items.length > 0;
      for (const pair of entry.group.assignments) {
        const attached = await pushHeadlines(pair, items, entry.outcome.checkedAt);
        if (countsForPhotos && photoOutcomes.get(pair.source.id) !== "working") {
          photoOutcomes.set(pair.source.id, attached > 0 ? "working" : "none");
        }
        if (!entry.outcome.fromCache) {
          results.push({
            sourceId: pair.source.id,
            assignmentId: pair.assignment.id,
            runtimeFingerprint: pair.source.runtimeFingerprint,
            targetUrl: pair.assignment.targetUrl,
            targetParameters: pair.assignment.targetParameters,
            healthState: entry.outcome.state,
            healthReasonCode: entry.outcome.reason,
            healthMessage: entry.outcome.message,
            checkedAt: entry.outcome.checkedAt
          });
        }
      }
    };

    await runAll([...groups.values()].map((group) => () => run(group)));
    await runAll(photoPhase.map((entry) => () => finish(entry)));

    if (this.dependencies.photos) {
      try {
        await this.dependencies.photos.sweep(accessContext, keptPhotoKeys);
      } catch {
        // Housekeeping only: an unswept copy expires on the next refresh.
      }
    }

    const persistedResults =
      results.length === 0
        ? 0
        : await this.dependencies.dataContext.withDataContext(accessContext, (db) =>
            this.repository.persistRuntimeResults(db, results)
          );
    if (photoOutcomes.size > 0) {
      try {
        await this.dependencies.dataContext.withDataContext(accessContext, async (db) => {
          for (const [sourceId, outcome] of photoOutcomes) {
            await recordSportsPhotoOutcome(db, sourceId, outcome);
          }
        });
      } catch {
        // The status line is a courtesy; failing to update it must never fail a refresh.
      }
    }
    return { headlines, degraded, persistedResults };
  }
}
