import { createHash } from "node:crypto";

import { DatasetCache, DEFAULT_STALE_RETENTION_MS } from "@moss/datasets";
import type { AccessContext, DataContextDb } from "@moss/db";
import { isPublicFeedDocument, parsePublicFeedItems } from "@moss/news";

import { catalogEntry } from "./catalog.js";
import type { SportsSafeFetchPort, SportsWebRequestHop } from "./discovery.js";
import {
  extractFeedPhoto,
  extractShareImage,
  isUsablePhotoCandidate,
  parseFeedPhotoItems
} from "./photo.js";
import type { SportsPhotoStore, StoredPhoto } from "./photo-store.js";
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
const MAX_RESPONSE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 6_000;
const REFRESH_DEADLINE_MS = 12_000;
const MAX_RETRY_AFTER_MS = 5_000;
const HEADLINE_TTL_MS = 10 * 60 * 1000;

export type SportsPublicSourceHeadline = CustomSourceHeadline & {
  readonly imageUrl: string | null;
  readonly sportKey: SportsRuntimeSource["assignments"][number]["scope"]["sportKey"];
};

/** #2237 the deterministic photo pass' budget, per source, per refresh. */
const MAX_ARTICLE_PAGE_FETCHES = 6;
const PHOTO_DEADLINE_MARGIN_MS = 3_000;
const ARTICLE_PAGE_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
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

interface RequestAssignment {
  readonly source: SportsRuntimeSource;
  readonly assignment: SportsRuntimeSource["assignments"][number];
}

interface RequestGroup {
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

interface ExtractedHeadline {
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

class DomainConcurrencyLimiter {
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
   * #2237 the deterministic photo pass: the feed's own media tag first, then the article page's
   * share image. Every failure here is swallowed — a story without a photo is still a story, and
   * a photo must never cost the reader its headlines.
   */
  private async attachPhotoUrls(
    group: RequestGroup,
    items: readonly ExtractedHeadline[],
    feedBody: string | null,
    context: {
      readonly deadline: number;
      readonly signal?: AbortSignal;
      readonly domainLimiter: DomainConcurrencyLimiter;
      readonly pageBudget: Map<string, number>;
    }
  ): Promise<readonly ExtractedHeadline[]> {
    const feedPhotos = new Map<string, string>();
    if (feedBody !== null) {
      for (const parsed of parseFeedPhotoItems(feedBody)) {
        if (!parsed.link) continue;
        const found = extractFeedPhoto(parsed);
        if (found) feedPhotos.set(parsed.link, found.url);
      }
    }
    const sourceIds = new Set(group.assignments.map((pair) => pair.source.id));
    const withPhotos: ExtractedHeadline[] = [];
    for (const item of items) {
      let publisherHost: string;
      try {
        publisherHost = new URL(item.url).hostname.toLowerCase();
      } catch {
        withPhotos.push(item);
        continue;
      }
      const fromFeed = feedPhotos.get(item.url);
      if (fromFeed && isUsablePhotoCandidate(fromFeed, { publisherHost })) {
        withPhotos.push({ ...item, photoUrl: fromFeed });
        continue;
      }
      const budgetLeft = [...sourceIds].every(
        (sourceId) => (context.pageBudget.get(sourceId) ?? 0) < MAX_ARTICLE_PAGE_FETCHES
      );
      if (
        !budgetLeft ||
        context.signal?.aborted ||
        this.now() + PHOTO_DEADLINE_MARGIN_MS >= context.deadline
      ) {
        withPhotos.push(item);
        continue;
      }
      for (const sourceId of sourceIds) {
        context.pageBudget.set(sourceId, (context.pageBudget.get(sourceId) ?? 0) + 1);
      }
      const shareUrl = await this.fetchShareImage(item.url, publisherHost, context);
      withPhotos.push(shareUrl ? { ...item, photoUrl: shareUrl } : item);
    }
    return withPhotos;
  }

  private async fetchShareImage(
    articleUrl: string,
    publisherHost: string,
    context: {
      readonly deadline: number;
      readonly signal?: AbortSignal;
      readonly domainLimiter: DomainConcurrencyLimiter;
    }
  ): Promise<string | null> {
    const held = await context.domainLimiter.acquireAll(
      [publisherHost],
      context.deadline,
      this.now,
      context.signal
    );
    if (!held) return null;
    try {
      // Waiting for the slot can itself consume most of what was left, so the deadline margin is
      // checked again here rather than only before the wait.
      if (
        context.signal?.aborted ||
        this.now() + PHOTO_DEADLINE_MARGIN_MS >= context.deadline
      ) {
        return null;
      }
      const response = await this.dependencies.fetch(articleUrl, {
        allowedHosts: [publisherHost],
        allowedContentTypes: ARTICLE_PAGE_CONTENT_TYPES,
        maxBytes: MAX_RESPONSE_BYTES,
        rejectOversizedResponses: true,
        timeoutMs: Math.min(FETCH_TIMEOUT_MS, Math.max(1, context.deadline - this.now())),
        signal: context.signal
      });
      if (!response.ok) return null;
      const found = extractShareImage(response.body, response.finalUrl);
      if (!found) return null;
      return isUsablePhotoCandidate(found.url, { publisherHost }) ? found.url : null;
    } catch {
      return null;
    } finally {
      for (const host of held) context.domainLimiter.release(host);
    }
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
    signal?: AbortSignal
  ): Promise<Map<string, StoredPhoto>> {
    const stored = new Map<string, StoredPhoto>();
    const photos = this.dependencies.photos;
    if (!photos) return stored;
    for (const item of items) {
      if (!item.photoUrl) continue;
      // A photo that already failed is not tried again while the story is still cached: without
      // this, a permanently broken image is re-downloaded on every single refresh.
      const failureKey = photoFailureKey(accessContext.actorUserId, pair.source.id, item.photoUrl);
      if (this.isRememberedPhotoFailure(failureKey)) continue;
      const timeBudgetMs = deadline - this.now();
      if (timeBudgetMs <= 0) continue;
      let copy: StoredPhoto | null;
      try {
        copy = await photos.ensure(accessContext, pair.source.id, item.photoUrl, {
          ...(signal ? { signal } : {}),
          timeBudgetMs
        });
      } catch {
        copy = null;
      }
      if (!copy) {
        this.rememberPhotoFailure(failureKey);
        continue;
      }
      stored.set(item.id, copy);
      photos.linkHeadline(
        accessContext.actorUserId,
        `${pair.source.id}:${item.id}`,
        copy.key
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
    const pending = [...groups.values()];
    const running = new Set<Promise<void>>();
    const domainLimiter = new DomainConcurrencyLimiter();
    const pageBudget = new Map<string, number>();
    const keptPhotoKeys = new Set<string>();

    const pushHeadlines = async (
      pair: RequestAssignment,
      items: readonly ExtractedHeadline[],
      checkedAt: Date | null
    ): Promise<void> => {
      const stored = await this.storePhotos(accessContext, pair, items, deadline, options.signal);
      for (const copy of stored.values()) keptPhotoKeys.add(copy.key);
      headlines.push(...publicHeadlines(pair, items, checkedAt, stored));
    };

    const run = async (group: RequestGroup): Promise<void> => {
      const cacheHit = options.bypassCache
        ? undefined
        : this.cache.get<readonly ExtractedHeadline[]>(group.identity, this.now());
      if (cacheHit?.fresh) {
        for (const pair of group.assignments) {
          await pushHeadlines(pair, cacheHit.value, null);
        }
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
      if (outcome.state === "healthy" && this.dependencies.photos) {
        outcome = {
          ...outcome,
          items: await this.attachPhotoUrls(
            group,
            outcome.items,
            group.kind === "feed" && response.ok ? response.body : null,
            { deadline, signal: options.signal, domainLimiter, pageBudget }
          )
        };
      }
      if (outcome.state === "healthy") {
        const cachedAt = this.now();
        this.cache.set(
          group.identity,
          outcome.items,
          cachedAt + HEADLINE_TTL_MS,
          cachedAt + HEADLINE_TTL_MS + DEFAULT_STALE_RETENTION_MS
        );
      } else {
        degraded = true;
      }
      for (const pair of group.assignments) {
        await pushHeadlines(pair, outcome.items, outcome.checkedAt);
        if (!outcome.fromCache) {
          results.push({
            sourceId: pair.source.id,
            assignmentId: pair.assignment.id,
            runtimeFingerprint: pair.source.runtimeFingerprint,
            targetUrl: pair.assignment.targetUrl,
            targetParameters: pair.assignment.targetParameters,
            healthState: outcome.state,
            healthReasonCode: outcome.reason,
            healthMessage: outcome.message,
            checkedAt: outcome.checkedAt
          });
        }
      }
    };

    while (pending.length > 0 || running.size > 0) {
      let scheduled = false;
      while (running.size < MAX_CONCURRENCY) {
        const group = pending.shift();
        if (!group) break;
        const promise = run(group).finally(() => {
          running.delete(promise);
        });
        running.add(promise);
        scheduled = true;
      }
      if (running.size > 0 && (!scheduled || running.size >= MAX_CONCURRENCY)) {
        await Promise.race(running);
      }
    }

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
    return { headlines, degraded, persistedResults };
  }
}
