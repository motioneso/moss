import { createHash } from "node:crypto";

import { DatasetCache, DEFAULT_STALE_RETENTION_MS } from "@moss/datasets";
import type { AccessContext, DataContextDb } from "@moss/db";
import { isPublicFeedDocument, parsePublicFeedItems } from "@moss/news";

import { catalogEntry } from "./catalog.js";
import type { SportsSafeFetchPort, SportsWebRequestHop } from "./discovery.js";
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
import type { CustomSourceHeadline } from "./sports-source.js";

const MAX_ASSIGNMENTS = 20;
const MAX_REQUESTS = 30;
const MAX_CONCURRENCY = 4;
const MAX_DOMAIN_CONCURRENCY = 2;
const MAX_RESPONSE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 6_000;
const REFRESH_DEADLINE_MS = 12_000;
const MAX_RETRY_AFTER_MS = 5_000;
const HEADLINE_TTL_MS = 10 * 60 * 1000;

export interface SportsPublicSourceHeadline extends CustomSourceHeadline {
  readonly imageUrl: null;
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
  budgetDenied: boolean
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
      message: "The publisher asked Moss to retry later."
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
  checkedAt: Date | null
): SportsPublicSourceHeadline[] {
  const { source, assignment } = pair;
  const fallbackTime = (checkedAt ?? new Date(0)).toISOString();
  return items.map((item) => ({
    origin: "custom",
    sourceId: source.id,
    id: `${source.id}:${item.id}`,
    competitionKey: assignment.competitionKey,
    competitionLabel: catalogEntry(assignment.competitionKey)?.label ?? assignment.competitionKey,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt ?? fallbackTime,
    imageUrl: null,
    summary: item.summary,
    teamKeys: assignment.teamKey ? [assignment.teamKey] : [],
    publisherLabel: source.label,
    publisherDomain: source.canonicalDomain
  }));
}

export class SportsPublicSourceReader {
  private readonly repository: SportsSourcesRepository;
  private readonly cache: DatasetCache;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly dependencies: PublicSourceReaderDependencies) {
    this.repository = dependencies.repository ?? new SportsSourcesRepository();
    this.cache = dependencies.cache ?? new DatasetCache({ maxEntries: 500 });
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
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
      if (source.retrievalMethod === "feed" && source.feedUrl) {
        group = {
          identity: stableId(`${source.runtimeFingerprint}\0${source.feedUrl}`),
          url: source.feedUrl,
          headers: {
            accept: "application/rss+xml, application/atom+xml, application/xml, text/xml"
          },
          allowedContentTypes: [
            "application/rss+xml",
            "application/atom+xml",
            "application/xml",
            "text/xml"
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

    const run = async (group: RequestGroup): Promise<void> => {
      const cacheHit = options.bypassCache
        ? undefined
        : this.cache.get<readonly ExtractedHeadline[]>(group.identity, this.now());
      if (cacheHit?.fresh) {
        for (const pair of group.assignments) {
          headlines.push(...publicHeadlines(pair, cacheHit.value, null));
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
      const beforeRequest = async (hop: SportsWebRequestHop): Promise<boolean> => {
        if (options.signal?.aborted || requestCount >= MAX_REQUESTS) {
          budgetDenied = requestCount >= MAX_REQUESTS;
          return false;
        }
        if (!group.allowedHosts.includes(hop.url.hostname.toLowerCase())) return false;
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
        const failure = failureState(response, budgetDenied);
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
        headlines.push(...publicHeadlines(pair, outcome.items, outcome.checkedAt));
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

    const persistedResults =
      results.length === 0
        ? 0
        : await this.dependencies.dataContext.withDataContext(accessContext, (db) =>
            this.repository.persistRuntimeResults(db, results)
          );
    return { headlines, degraded, persistedResults };
  }
}
