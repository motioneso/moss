import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import {
  confirmNewsSourceSchema,
  createNewsSourceExclusionSchema,
  createNewsTopicSchema,
  deleteNewsCustomSourceSchema,
  deleteNewsSourceExclusionSchema,
  deleteNewsTopicSchema,
  getNewsPersonalizationSchema,
  previewNewsSourceSchema,
  triggerNewsRefreshSchema,
  triggerNewsRevalidationSchema,
  updateNewsTopicSchema,
  type ConfirmNewsSourceRequest,
  type CreateNewsSourceExclusionRequest,
  type CreateNewsTopicRequest,
  type GetNewsPersonalizationResponse,
  type NewsCustomSourceDto,
  type NewsCustomTopicDto,
  type NewsRefreshStateDto,
  type NewsPublisherConnectionOfferDto,
  type NewsSourceExclusionDto,
  type NewsSourcePreviewRequest,
  type NewsSourcePreviewResponse,
  type NewsSnapshotMetaDto,
  type UpdateNewsTopicRequest
} from "@moss/shared";

import { findDuplicateCustomSource, resolveSourceInput } from "./discovery/source-resolution.js";
import { validateTopic } from "./discovery/policy-validation.js";
import type {
  NewsAiPort,
  NewsFetchPort,
  NewsSafeFetchPort,
  NewsWebSearchPort
} from "./discovery/ports.js";
import { createPreviewStore } from "./discovery/preview-store.js";
import { enqueueNewsRefresh, enqueueNewsRevalidation } from "./jobs.js";
import { normalizePublisherDomain } from "./personalization-domain.js";
import {
  NewsDuplicateSourceError,
  NewsPersonalizationLimitError,
  type NewsSnapshotRecord
} from "./personalization-repository.js";
import { isNewsSnapshotFresh } from "./news-service.js";
import type { NewsPublisherConnectionPort } from "./publisher-connection-port.js";
import { reconcileNewsRevalidationSchedule } from "./schedule.js";

export interface NewsPersonalizationStore {
  listCustomSources(scopedDb: DataContextDb): Promise<NewsCustomSourceDto[]>;
  createCustomSource(
    scopedDb: DataContextDb,
    input: {
      label: string;
      canonicalDomain: string;
      homepageUrl: string;
      feedUrl: string | null;
      retrievalMethod: "feed" | "scrape" | "reddit";
      confirmedFetchHosts: readonly string[];
      iconUrl: string | null;
      validationFingerprint: string;
    }
  ): Promise<NewsCustomSourceDto>;
  replaceCustomSource(
    scopedDb: DataContextDb,
    sourceId: string,
    input: {
      label: string;
      canonicalDomain: string;
      homepageUrl: string;
      feedUrl: string | null;
      retrievalMethod: "feed" | "scrape" | "reddit";
      confirmedFetchHosts: readonly string[];
      iconUrl: string | null;
      validationFingerprint: string;
    }
  ): Promise<NewsCustomSourceDto | null>;
  deleteCustomSource(scopedDb: DataContextDb, sourceId: string): Promise<boolean>;
  countCustomSources(scopedDb: DataContextDb): Promise<number>;
  countCustomTopics(scopedDb: DataContextDb): Promise<number>;
  listCustomTopics(scopedDb: DataContextDb): Promise<NewsCustomTopicDto[]>;
  createCustomTopic(
    scopedDb: DataContextDb,
    input: { label: string; guidance: string | null; validationFingerprint: string }
  ): Promise<NewsCustomTopicDto>;
  updateCustomTopic(
    scopedDb: DataContextDb,
    topicId: string,
    input: { label: string; guidance: string | null; validationFingerprint: string }
  ): Promise<NewsCustomTopicDto | null>;
  deleteCustomTopic(scopedDb: DataContextDb, topicId: string): Promise<boolean>;
  listExclusions(scopedDb: DataContextDb): Promise<NewsSourceExclusionDto[]>;
  createExclusion(scopedDb: DataContextDb, domain: string): Promise<NewsSourceExclusionDto>;
  removeExclusion(scopedDb: DataContextDb, id: string): Promise<boolean>;
  readLatestSnapshot(scopedDb: DataContextDb): Promise<NewsSnapshotRecord | null>;
  readRefreshState(scopedDb: DataContextDb): Promise<NewsRefreshStateDto>;
  bumpRefreshRequest(scopedDb: DataContextDb): Promise<number>;
  pruneSnapshotDomain(scopedDb: DataContextDb, domain: string): Promise<void>;
  updateSourceHealth(
    scopedDb: DataContextDb,
    sourceId: string,
    health:
      | "healthy"
      | "authentication_failed"
      | "temporarily_unavailable"
      | "unsupported"
      | "disabled"
  ): Promise<void>;
  readPolicyVerdict(
    scopedDb: DataContextDb,
    domain: string,
    fingerprint: string
  ): Promise<"approved" | "rejected" | null>;
  upsertPolicyVerdict(
    scopedDb: DataContextDb,
    input: {
      canonicalDomain: string;
      fingerprint: string;
      verdict: "approved" | "rejected";
      ttlMs: number;
    }
  ): Promise<void>;
}

/** The in-memory preview store shared by the REST routes and the chat tools (#975 Slice 4). */
export type NewsSourcePreviewStore = ReturnType<typeof createPreviewStore>;

export interface PersonalizationRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly availability: {
    hasJsonModel(scopedDb: DataContextDb): Promise<boolean>;
    hasWebSearch(scopedDb: DataContextDb): Promise<boolean>;
  };
  readonly discovery: {
    readonly fetch: NewsSafeFetchPort;
    /** #2282: optional here so existing test fakes keep working; the composition root always passes it. */
    readonly fetchWithOptions?: NewsFetchPort;
    readonly search: NewsWebSearchPort;
    readonly ai: NewsAiPort;
  };
  readonly boss: PgBoss | null;
  readonly repository: NewsPersonalizationStore;
  /**
   * #975 Slice 4: injected so `routes.ts` can hand the SAME store to
   * `configureNewsChatTools` — a source previewed in chat is confirmable over
   * REST and vice versa. Defaults to a private store for existing callers.
   */
  readonly previews?: NewsSourcePreviewStore;
  /** #1110: UAT-only deterministic override for the source-preview route; see module-registry's buildUatNewsPreviewOverride(). */
  readonly previewOverride?: (input: string) => NewsSourcePreviewResponse | undefined;
  /**
   * #2008: the reviewed publisher connections, so a preview can tell the user up front that
   * this publisher needs a key. Optional: with no port the preview answers exactly as before.
   */
  readonly connections?: NewsPublisherConnectionPort;
}

/**
 * #2008: the offer News shows above the key box.
 *
 * Two rules live here rather than in the caller. The offer is only ever built for a preview that
 * found EXACTLY ONE candidate, because asking for a key on an ambiguous match means asking
 * someone to send a secret to a guessed publisher. And the offer carries five display fields
 * only — never the endpoint, the header name, or anything else about the outgoing request.
 */
function connectionOfferFor(
  connections: NewsPublisherConnectionPort | undefined,
  candidates: readonly { readonly homepageUrl: string }[]
): NewsPublisherConnectionOfferDto | undefined {
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (!connections || !only) return undefined;
  const descriptor = connections.matchUrl(only.homepageUrl);
  if (!descriptor) return undefined;
  return {
    connectionId: descriptor.connectionId,
    publisherName: descriptor.publisherName,
    requestHost: descriptor.host,
    accessSummary: descriptor.accessSummary,
    termsUrl: descriptor.termsUrl
  };
}

function toSnapshotMeta(record: NewsSnapshotRecord | null): NewsSnapshotMetaDto | null {
  if (!record) return null;
  const articles = (record.payload as { articles?: unknown }).articles;
  return {
    compiledAt: record.compiledAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    articleCount: Array.isArray(articles) ? articles.length : 0
  };
}

// Exported for the news.addTopic chat tool (#975 Task 8) — the single trim/normalize
// path for topic input, so REST and chat write byte-identical rows. Chat pre-checks
// the empty label itself (benign tool error), so the HttpError never fires there.
export function cleanTopic(input: { label: string; guidance?: string }): {
  label: string;
  guidance: string | null;
} {
  const label = input.label.trim();
  if (!label) throw new HttpError(400, "Topic label is required");
  return { label, guidance: input.guidance?.trim() || null };
}

function mapWriteError(error: unknown): never {
  if (error instanceof NewsPersonalizationLimitError) throw new HttpError(400, error.message);
  if (error instanceof NewsDuplicateSourceError) throw new HttpError(409, error.message);
  throw error;
}

export async function triggerNewsRefresh(
  scopedDb: DataContextDb,
  repository: Pick<
    NewsPersonalizationStore,
    "bumpRefreshRequest" | "countCustomSources" | "countCustomTopics"
  >,
  boss: PgBoss | null,
  actorUserId: string,
  afterBump?: () => Promise<void>,
  logger?: Pick<FastifyBaseLogger, "error">
): Promise<boolean> {
  await repository.bumpRefreshRequest(scopedDb);
  await afterBump?.();
  if (!boss) return false;
  // Every personalization write funnels through here, so the per-owner daily
  // revalidation schedule stays reconciled as a side effect (best-effort inside).
  await reconcileNewsRevalidationSchedule(boss, scopedDb, repository, actorUserId, logger);
  return enqueueNewsRefresh(boss, actorUserId);
}

export type ConfirmSourceFromPreviewResult =
  | { ok: true; source: NewsCustomSourceDto }
  | { ok: false; reason: "expired" | "ambiguous" | "duplicate" | "limit"; message: string };

/**
 * Confirm-from-preview write path shared by the REST route and the
 * `news.confirmSource` chat tool (#975 Slice 4). Benign outcomes return
 * `{ok:false, reason, message}` so each caller maps them to its own surface
 * (REST → HttpError status, chat tool → error text the model can relay).
 *
 * `expected` is the chat-tool tamper check: the display fields the owner
 * approved in the confirmation prompt must match the STORED candidate. A
 * mismatch means the model/client swapped the write target after approval —
 * a security violation, so it THROWS (the gateway sanitizes the message and
 * audits the call as failed) rather than returning a benign failure.
 */
export async function confirmSourceFromPreview(
  scopedDb: DataContextDb,
  deps: {
    previews: NewsSourcePreviewStore;
    repository: NewsPersonalizationStore;
    boss: PgBoss | null;
  },
  actorUserId: string,
  input: {
    confirmationId: string;
    candidateId?: string;
    expected?: { label: string; domain: string };
  }
): Promise<ConfirmSourceFromPreviewResult> {
  // take() is owner-checked — another actor's confirmationId reads as expired.
  const preview = deps.previews.take(actorUserId, input.confirmationId);
  if (!preview) {
    return { ok: false, reason: "expired", message: "Source preview expired or was not found" };
  }
  if (preview.candidates.length > 1 && !input.candidateId) {
    return { ok: false, reason: "ambiguous", message: "Choose a publisher candidate" };
  }
  const candidate = input.candidateId
    ? preview.candidates.find((item) => item.candidateId === input.candidateId)
    : preview.candidates[0];
  if (!candidate) {
    return { ok: false, reason: "ambiguous", message: "Publisher candidate is invalid" };
  }
  if (
    input.expected &&
    (candidate.label !== input.expected.label ||
      candidate.canonicalDomain !== input.expected.domain)
  ) {
    throw new Error("Confirmed source does not match the previewed candidate");
  }
  try {
    const write = {
      label: candidate.label,
      canonicalDomain: candidate.canonicalDomain,
      homepageUrl: candidate.homepageUrl,
      feedUrl: candidate.feedUrl,
      retrievalMethod: candidate.retrievalMethod,
      // #2282 Task 1.6: the preview decided these while it had the evidence in hand; confirming
      // copies them rather than guessing again from the URLs. The tamper check above is unchanged.
      confirmedFetchHosts: candidate.confirmedFetchHosts,
      iconUrl: candidate.iconUrl,
      validationFingerprint: candidate.validationFingerprint
    };
    const created = preview.replaceSourceId
      ? await deps.repository.replaceCustomSource(scopedDb, preview.replaceSourceId, write)
      : await deps.repository.createCustomSource(scopedDb, write);
    if (!created) {
      return { ok: false, reason: "expired", message: "Source to replace was not found" };
    }
    await triggerNewsRefresh(scopedDb, deps.repository, deps.boss, actorUserId);
    return { ok: true, source: created };
  } catch (error) {
    if (error instanceof NewsPersonalizationLimitError) {
      return { ok: false, reason: "limit", message: error.message };
    }
    if (error instanceof NewsDuplicateSourceError) {
      return { ok: false, reason: "duplicate", message: error.message };
    }
    throw error;
  }
}

/** REST status mapping preserves the pre-extraction route behavior exactly. */
const confirmFailureStatus: Record<"expired" | "ambiguous" | "duplicate" | "limit", number> = {
  expired: 409,
  ambiguous: 400,
  duplicate: 409,
  limit: 400
};

export function registerNewsPersonalizationRoutes(
  server: FastifyInstance,
  dependencies: PersonalizationRouteDependencies
): void {
  const repository = dependencies.repository;
  const previews = dependencies.previews ?? createPreviewStore();

  server.get(
    "/api/news/personalization",
    { schema: getNewsPersonalizationSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const [customSources, customTopics, sourceExclusions, snapshot, jsonModel, webSearch] =
            await Promise.all([
              repository.listCustomSources(db),
              repository.listCustomTopics(db),
              repository.listExclusions(db),
              repository.readLatestSnapshot(db),
              dependencies.availability.hasJsonModel(db),
              dependencies.availability.hasWebSearch(db)
            ]);
          let refresh = await repository.readRefreshState(db);
          if (!isNewsSnapshotFresh(snapshot)) {
            await triggerNewsRefresh(
              db,
              repository,
              dependencies.boss,
              accessContext.actorUserId,
              undefined,
              request.log
            );
            refresh = await repository.readRefreshState(db);
          } else if (dependencies.boss) {
            // Self-heal the daily revalidation schedule on reads too — a failed
            // reconcile during a past write must not leave the owner unscheduled.
            await reconcileNewsRevalidationSchedule(
              dependencies.boss,
              db,
              repository,
              accessContext.actorUserId,
              request.log
            );
          }
          const response: GetNewsPersonalizationResponse = {
            availability: {
              aiConfigured: jsonModel,
              webSearchConfigured: webSearch,
              customSourceByUrlEnabled: jsonModel,
              customSourceByNameEnabled: jsonModel && webSearch,
              freeformTopicsEnabled: jsonModel && webSearch
            },
            customSources,
            customTopics,
            sourceExclusions,
            snapshot: toSnapshotMeta(snapshot),
            refresh
          };
          return response;
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/news/sources/preview",
    { schema: previewNewsSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as NewsSourcePreviewRequest;
        // #1110: UAT-only deterministic override, checked before the hasJsonModel gate below
        // (both the "declared prerequisite" and "transient error" UAT specs share a
        // withoutNewsJsonBinding:true seed level, so the override must win first or the
        // transient-input case would incorrectly surface as a prerequisite error instead).
        const override = dependencies.previewOverride?.(input.input);
        if (override) return override;
        return await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const [hasJsonModel, hasWebSearch] = await Promise.all([
            dependencies.availability.hasJsonModel(db),
            dependencies.availability.hasWebSearch(db)
          ]);
          if (!hasJsonModel) {
            return {
              status: "unavailable" as const,
              error: {
                code: "news.add_source.no_json_model",
                class: "prerequisite" as const,
                remediationRef: "news.add_source.configure_json_model"
              }
            };
          }
          const result = await resolveSourceInput(
            db,
            { ...dependencies.discovery, repo: repository },
            { raw: input.input, hasWebSearch }
          );
          if (result.status === "unavailable") {
            return {
              ...result,
              error: { code: "news.add_source.discovery_unavailable", class: "transient" as const }
            };
          }
          if (result.status !== "ok" && result.status !== "ambiguous") return result;

          const confirmationId = previews.put({
            ownerUserId: accessContext.actorUserId,
            candidates: result.candidates,
            replaceSourceId: input.replaceSourceId ?? null,
            createdAt: Date.now()
          });
          const existing = input.replaceSourceId ? [] : await repository.listCustomSources(db);
          const duplicate = result.candidates
            .map((candidate) => findDuplicateCustomSource(existing, candidate))
            .find(Boolean);
          const connection = connectionOfferFor(dependencies.connections, result.candidates);
          return {
            status: result.status,
            confirmationId,
            candidates: result.candidates.map((candidate) => ({
              label: candidate.label,
              canonicalDomain: candidate.canonicalDomain,
              homepageUrl: candidate.homepageUrl,
              retrievalMethod: candidate.retrievalMethod,
              sampleCount: candidate.sampleCount,
              ...(candidate.redirectNote ? { redirectNote: candidate.redirectNote } : {})
            })),
            candidateIds: result.candidates.map((candidate) => candidate.candidateId),
            ...(duplicate ? { duplicateOfSourceId: duplicate.id } : {}),
            ...(connection ? { connection } : {})
          };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post("/api/news/sources", { schema: confirmNewsSourceSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const input = request.body as ConfirmNewsSourceRequest;
      const source = await dependencies.dataContext.withDataContext(accessContext, async (db) => {
        // No `expected` here: the REST client resubmits only IDs, so there are
        // no display fields to tamper-check (that guard is chat-tool-specific).
        const outcome = await confirmSourceFromPreview(
          db,
          { previews, repository, boss: dependencies.boss },
          accessContext.actorUserId,
          { confirmationId: input.confirmationId, candidateId: input.candidateId }
        );
        if (!outcome.ok) {
          throw new HttpError(confirmFailureStatus[outcome.reason], outcome.message);
        }
        return outcome.source;
      });
      reply.code(201);
      return { source };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.delete(
    "/api/news/sources/:id",
    { schema: deleteNewsCustomSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const deleted = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            const source = (await repository.listCustomSources(db)).find((item) => item.id === id);
            const removed = await repository.deleteCustomSource(db, id);
            if (removed && source) {
              await triggerNewsRefresh(
                db,
                repository,
                dependencies.boss,
                accessContext.actorUserId,
                () => repository.pruneSnapshotDomain(db, source.canonicalDomain)
              );
            }
            return removed;
          }
        );
        return { deleted };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post("/api/news/topics", { schema: createNewsTopicSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      const input = cleanTopic(request.body as CreateNewsTopicRequest);
      const topic = await dependencies.dataContext.withDataContext(accessContext, async (db) => {
        if (!(await dependencies.availability.hasWebSearch(db))) {
          throw new HttpError(503, "Topic discovery requires web search");
        }
        const policy = await validateTopic(db, { ai: dependencies.discovery.ai }, input);
        if (policy.verdict === "unavailable")
          throw new HttpError(503, "Topic validation unavailable");
        if (policy.verdict === "rejected") throw new HttpError(422, "Topic is not allowed");
        try {
          const created = await repository.createCustomTopic(db, {
            ...input,
            validationFingerprint: policy.fingerprint
          });
          await triggerNewsRefresh(db, repository, dependencies.boss, accessContext.actorUserId);
          return created;
        } catch (error) {
          return mapWriteError(error);
        }
      });
      reply.code(201);
      return { topic };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  server.patch(
    "/api/news/topics/:id",
    { schema: updateNewsTopicSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const update = request.body as UpdateNewsTopicRequest;
        const topic = await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const current = (await repository.listCustomTopics(db)).find((item) => item.id === id);
          if (!current) throw new HttpError(400, "Topic was not found");
          const input = cleanTopic({
            label: update.label ?? current.label,
            guidance: update.guidance ?? current.guidance ?? undefined
          });
          if (!(await dependencies.availability.hasWebSearch(db))) {
            throw new HttpError(503, "Topic discovery requires web search");
          }
          const policy = await validateTopic(db, { ai: dependencies.discovery.ai }, input);
          if (policy.verdict === "unavailable") {
            throw new HttpError(503, "Topic validation unavailable");
          }
          if (policy.verdict === "rejected") throw new HttpError(422, "Topic is not allowed");
          const changed = await repository.updateCustomTopic(db, id, {
            ...input,
            validationFingerprint: policy.fingerprint
          });
          if (!changed) throw new HttpError(400, "Topic was not found");
          await triggerNewsRefresh(db, repository, dependencies.boss, accessContext.actorUserId);
          return changed;
        });
        return { topic };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/news/topics/:id",
    { schema: deleteNewsTopicSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const deleted = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            const removed = await repository.deleteCustomTopic(db, id);
            if (removed) {
              await triggerNewsRefresh(
                db,
                repository,
                dependencies.boss,
                accessContext.actorUserId
              );
            }
            return removed;
          }
        );
        return { deleted };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/news/source-exclusions",
    { schema: createNewsSourceExclusionSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as CreateNewsSourceExclusionRequest;
        const normalized = normalizePublisherDomain(input.source);
        if (!normalized.ok) {
          throw new HttpError(400, `Invalid publisher domain (${normalized.reason})`);
        }
        const exclusion = await dependencies.dataContext.withDataContext(
          accessContext,
          async (db) => {
            try {
              const created = await repository.createExclusion(db, normalized.domain);
              await triggerNewsRefresh(
                db,
                repository,
                dependencies.boss,
                accessContext.actorUserId,
                () => repository.pruneSnapshotDomain(db, normalized.domain)
              );
              return created;
            } catch (error) {
              return mapWriteError(error);
            }
          }
        );
        return { exclusion };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/news/source-exclusions/:id",
    { schema: deleteNewsSourceExclusionSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const ok = await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const removed = await repository.removeExclusion(db, id);
          if (removed) {
            await triggerNewsRefresh(db, repository, dependencies.boss, accessContext.actorUserId);
          }
          return removed;
        });
        return { ok };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  // Manual retry for owners whose sources/topics need attention (#975 Slice 4). No
  // bump/reconcile here — revalidation reads current items, it doesn't change them.
  server.post(
    "/api/news/revalidation",
    { schema: triggerNewsRevalidationSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const queued = dependencies.boss
          ? await enqueueNewsRevalidation(dependencies.boss, accessContext.actorUserId)
          : false;
        reply.code(202);
        return { queued };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post("/api/news/refresh", { schema: triggerNewsRefreshSchema }, async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      return await dependencies.dataContext.withDataContext(accessContext, async (db) => {
        const queued = await triggerNewsRefresh(
          db,
          repository,
          dependencies.boss,
          accessContext.actorUserId
        );
        const refresh = await repository.readRefreshState(db);
        return { queued, state: refresh.state };
      });
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
}
