import type { PgBoss } from "pg-boss";

import type { DataContextRunner } from "@moss/db";
import {
  assertMetadataOnlyPayload,
  registerDataContextWorker,
  sendJob,
  type ActorScopedJobPayload,
  type QueueDefinition,
  toAccessContext
} from "@moss/jobs";
import type { NotificationsRepository } from "@moss/notifications";

import {
  compilePersonalizedNews,
  type CompilationRepository,
  type MetadataLogger
} from "./compilation/compile.js";
import type {
  NewsAiPort,
  NewsFetchPort,
  NewsSafeFetchPort,
  NewsWebSearchPort
} from "./discovery/ports.js";
import { NEWS_MODULE_ID } from "./module-id.js";
import { NewsPersonalizationRepository } from "./personalization-repository.js";
import type { NewsStoryFeedbackPort } from "./story-feedback-port.js";
import { NewsPrefsRepository } from "./repository.js";
import { revalidateOwnerNews, type NewsRevalidationLogger } from "./revalidation.js";
import { NEWS_CATALOG } from "./source/catalog.js";
import type { NewsCredentialedSourceReader } from "./compilation/candidates.js";
import type { NewsCredentialStore } from "./credential-repository.js";

export const NEWS_REFRESH_QUEUE = "news.refresh";
export const NEWS_REVALIDATE_QUEUE = "news.revalidate";

export const NEWS_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: NEWS_REFRESH_QUEUE,
    options: {
      policy: "exclusive",
      retryLimit: 0,
      deleteAfterSeconds: 60,
      retentionSeconds: 60
    }
  },
  {
    name: NEWS_REVALIDATE_QUEUE,
    options: {
      policy: "exclusive",
      retryLimit: 0,
      deleteAfterSeconds: 60,
      retentionSeconds: 60
    }
  }
];

export interface NewsRefreshPayload extends ActorScopedJobPayload {
  readonly kind: "user_refresh";
  readonly idempotencyKey: string;
}

export interface NewsRevalidatePayload extends ActorScopedJobPayload {
  readonly kind: "revalidate";
  readonly idempotencyKey: string;
}

type NewsJobRepository = CompilationRepository &
  Pick<
    NewsPersonalizationRepository,
    | "beginRefreshRun"
    | "failRefreshRunIfCurrent"
    | "listSourceValidationStates"
    | "listTopicValidationStates"
    | "updateSourceValidation"
    | "updateTopicValidation"
  >;

export async function enqueueNewsRefresh(boss: PgBoss, actorUserId: string): Promise<boolean> {
  const idempotencyKey = `news-refresh:${actorUserId}`;
  const id = await sendJob(
    boss,
    NEWS_REFRESH_QUEUE,
    { actorUserId, kind: "user_refresh", idempotencyKey },
    { singletonKey: actorUserId }
  );
  return id !== null;
}

export async function enqueueNewsRevalidation(boss: PgBoss, actorUserId: string): Promise<boolean> {
  const idempotencyKey = `news-revalidate:${actorUserId}`;
  const id = await sendJob(
    boss,
    NEWS_REVALIDATE_QUEUE,
    { actorUserId, kind: "revalidate", idempotencyKey },
    { singletonKey: actorUserId }
  );
  return id !== null;
}

export async function registerNewsJobWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  deps: {
    readonly fetch: NewsSafeFetchPort;
    /** #2282: the options-capable port the Reddit collector branch uses; `fetch` stays URL-only. */
    readonly fetchWithOptions: NewsFetchPort;
    readonly search: NewsWebSearchPort;
    readonly ai: NewsAiPort;
    readonly logger: MetadataLogger;
    readonly repository?: NewsJobRepository;
    readonly prefsRepository?: Pick<NewsPrefsRepository, "list">;
    // Optional so existing callers/tests without notification wiring keep working; the
    // composition root always passes one. Pick keeps the seam minimal and stubbable.
    readonly notificationsRepository?: Pick<NotificationsRepository, "create">;
    readonly revalidationLogger?: NewsRevalidationLogger;
    readonly credentials?: Pick<NewsCredentialStore, "readStatuses">;
    readonly credentialedSource?: NewsCredentialedSourceReader;
    /**
     * #2018: story usefulness feedback. Optional so existing callers without it keep working;
     * the composition root always passes one.
     */
    readonly storyFeedback?: NewsStoryFeedbackPort;
  }
): Promise<string[]> {
  const repository = deps.repository ?? new NewsPersonalizationRepository();
  const prefs = deps.prefsRepository ?? new NewsPrefsRepository();
  const revalidationLogger = deps.revalidationLogger ?? { info: () => undefined };
  const refreshWorkId = await boss.work<NewsRefreshPayload, { outcome: string }>(
    NEWS_REFRESH_QUEUE,
    { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error(`pg-boss invoked ${NEWS_REFRESH_QUEUE} without a job`);
      assertMetadataOnlyPayload(job.data);
      const accessContext = toAccessContext(job);
      for (;;) {
        let generation: number | undefined;
        try {
          const attempt = await dataContext.withDataContext(accessContext, async (scopedDb) => {
            generation = await repository.beginRefreshRun(scopedDb);
            const result = await compilePersonalizedNews(
              scopedDb,
              {
                fetch: deps.fetch,
                fetchWithOptions: deps.fetchWithOptions,
                search: deps.search,
                ai: deps.ai,
                repo: repository,
                prefs,
                catalog: NEWS_CATALOG,
                logger: deps.logger,
                ...(deps.credentials ? { credentials: deps.credentials } : {}),
                ...(deps.credentialedSource ? { credentialedSource: deps.credentialedSource } : {}),
                ...(deps.storyFeedback ? { storyFeedback: deps.storyFeedback } : {})
              },
              { now: new Date(), generation, ownerUserId: accessContext.actorUserId }
            );
            if (result.outcome === "stale") return { outcome: "stale" as const };

            if (result.outcome === "replaced") {
              // Provider-change drift hook (#975 Slice 4): a verdict is only meaningful under
              // the fingerprint it was computed with, so any stored fingerprint that differs
              // from the CURRENT provider fingerprint means the owner's config changed since
              // validation. Enqueue (singleton-coalesced) rather than revalidate inline so the
              // refresh run stays fast and revalidation failures can't fail the refresh.
              const fingerprint = await deps.ai.fingerprint(scopedDb);
              if (fingerprint !== null) {
                const [sources, topics] = await Promise.all([
                  repository.listSourceValidationStates(scopedDb),
                  repository.listTopicValidationStates(scopedDb)
                ]);
                const drifted = [...sources, ...topics].some(
                  (item) => item.validationFingerprint !== fingerprint
                );
                if (drifted) await enqueueNewsRevalidation(boss, job.data.actorUserId);
              }
              return { outcome: result.outcome };
            }

            return {
              outcome: result.outcome,
              generation,
              failureKind: result.failureKind ?? "internal"
            };
          });

          if (attempt.outcome === "stale") continue;
          if (attempt.generation !== undefined) {
            const finished = await repository.failRefreshRunIfCurrent(
              dataContext,
              accessContext,
              attempt.generation,
              attempt.failureKind
            );
            if (!finished) continue;
          }
          return { outcome: attempt.outcome };
        } catch (error) {
          if (generation !== undefined) {
            try {
              await repository.failRefreshRunIfCurrent(
                dataContext,
                accessContext,
                generation,
                "internal"
              );
            } catch {
              // Preserve the original job error if the recovery write also fails.
            }
          }
          throw error;
        }
      }
    }
  );
  const revalidateWorkId = await registerDataContextWorker<
    NewsRevalidatePayload,
    { transitionedToAttention: boolean }
  >(boss, NEWS_REVALIDATE_QUEUE, dataContext, async (job, scopedDb) => {
    assertMetadataOnlyPayload(job.data);
    const outcome = await revalidateOwnerNews(scopedDb, {
      fetch: deps.fetch,
      fetchWithOptions: deps.fetchWithOptions,
      ai: deps.ai,
      repository,
      logger: revalidationLogger
    });
    // Exactly ONE summary notification per breakage: `transitionedToAttention` is true only
    // when this run moved a previously-fine item into needs-attention, so reruns over the
    // same broken state stay silent. Metadata is counts-only — never labels or domains.
    if (outcome.transitionedToAttention && deps.notificationsRepository) {
      try {
        await deps.notificationsRepository.create(scopedDb, {
          moduleId: NEWS_MODULE_ID,
          title: "News sources need attention",
          body: "Open News settings to retry or remove them.",
          metadata: {
            kind: "news_revalidation",
            sourceCount: outcome.sourcesNeedingAttention,
            topicCount: outcome.topicsNeedingAttention
          },
          urgency: "normal"
        });
      } catch (error) {
        // Best-effort delivery (briefings precedent): the revalidation writes are already
        // committed, so a notification failure is logged (bounded fields) and swallowed.
        const e = error instanceof Error ? error : new Error(String(error));
        revalidationLogger.info({
          event: "news_notification_failed",
          error: e.name,
          message: e.message.slice(0, 200)
        });
      }
    }
    return { transitionedToAttention: outcome.transitionedToAttention };
  });
  return [refreshWorkId, revalidateWorkId];
}
