// packages/news/src/revalidation.ts
// #975 Slice 4 — provider-change revalidation core. When the owner's configured AI
// provider/model changes (detected by fingerprint drift), every previously-validated
// custom source and topic must be re-checked against the NEW provider's policy, because a
// verdict is only meaningful under the fingerprint it was computed with. Runs under the
// worker data context; all writes go through the actor-scoped repository so RLS keeps the
// run inside the owning user's rows. Pure orchestration — no direct SQL here.
import type { DataContextDb } from "@moss/db";

import { extractListingHeadlines, sampleFeedHeadlines } from "./discovery/feed-discovery.js";
import { decideSourcePolicy, validateTopic } from "./discovery/policy-validation.js";
import type { NewsAiPort, NewsSafeFetchPort } from "./discovery/ports.js";
import type {
  NewsPersonalizationRepository,
  NewsSourceValidationState,
  NewsTopicValidationState
} from "./personalization-repository.js";

// Metadata-only by construction: counts and enum reasons, never domains/labels/bodies.
// `news_notification_failed` carries only the error class name and a capped message —
// the notification write is best-effort and must never take the revalidation run down.
export type NewsRevalidationLogFields =
  | { readonly event: "news_revalidation_skipped"; readonly reason: "no_model" }
  | {
      readonly event: "news_revalidation_run";
      readonly sourcesChecked: number;
      readonly topicsChecked: number;
      readonly sourcesNeedingAttention: number;
      readonly topicsNeedingAttention: number;
    }
  | {
      readonly event: "news_notification_failed";
      readonly error: string;
      readonly message: string;
    };

export interface NewsRevalidationLogger {
  info(fields: NewsRevalidationLogFields): void;
}

export interface NewsRevalidationDeps {
  readonly fetch: NewsSafeFetchPort;
  readonly ai: NewsAiPort;
  readonly repository: Pick<
    NewsPersonalizationRepository,
    | "listSourceValidationStates"
    | "listTopicValidationStates"
    | "updateSourceValidation"
    | "updateTopicValidation"
    | "updateSourceHealth"
    | "readPolicyVerdict"
    | "upsertPolicyVerdict"
  >;
  readonly logger: NewsRevalidationLogger;
}

export interface NewsRevalidationOutcome {
  readonly sourcesChecked: number;
  readonly topicsChecked: number;
  readonly sourcesNeedingAttention: number;
  readonly topicsNeedingAttention: number;
  /**
   * True iff an item that did NOT need attention before this run needs it now. This is
   * the notification dedupe: running twice over the same broken state transitions nothing
   * the second time, so the owner gets exactly one summary notification per breakage.
   */
  readonly transitionedToAttention: boolean;
}

const HEADLINE_SAMPLE_CAP = 10;

function sourceNeedsAttention(source: NewsSourceValidationState): boolean {
  return source.validationStatus !== "approved" || source.healthStatus !== "healthy";
}

function topicNeedsAttention(topic: NewsTopicValidationState): boolean {
  return topic.validationStatus !== "approved";
}

export async function revalidateOwnerNews(
  scopedDb: DataContextDb,
  deps: NewsRevalidationDeps
): Promise<NewsRevalidationOutcome> {
  // No configured model → nothing to validate against. Leave all state untouched so the
  // scheduled run retries once the owner configures a provider.
  const fingerprint = await deps.ai.fingerprint(scopedDb);
  if (fingerprint === null) {
    deps.logger.info({ event: "news_revalidation_skipped", reason: "no_model" });
    return {
      sourcesChecked: 0,
      topicsChecked: 0,
      sourcesNeedingAttention: 0,
      topicsNeedingAttention: 0,
      transitionedToAttention: false
    };
  }

  const sourcesBefore = await deps.repository.listSourceValidationStates(scopedDb);
  const topicsBefore = await deps.repository.listTopicValidationStates(scopedDb);

  let sourcesChecked = 0;
  for (const source of sourcesBefore) {
    // Idempotency: an approved verdict under the current fingerprint is still valid.
    if (source.validationStatus === "approved" && source.validationFingerprint === fingerprint) {
      continue;
    }
    sourcesChecked += 1;
    const fetched = await deps.fetch(source.feedUrl ?? source.homepageUrl);
    if (!fetched.ok) {
      // Unreachable → owner action required: surface both the health problem and that the
      // verdict is stale under the new fingerprint (so retry re-checks it).
      if (source.healthStatus !== "authentication_failed") {
        await deps.repository.updateSourceHealth(scopedDb, source.id, "temporarily_unavailable");
      }
      await deps.repository.updateSourceValidation(scopedDb, source.id, {
        validationStatus: "needs_revalidation",
        validationFingerprint: fingerprint
      });
      continue;
    }
    const sampleHeadlines =
      source.retrievalMethod === "feed"
        ? sampleFeedHeadlines(fetched.body, HEADLINE_SAMPLE_CAP).map((item) => item.headline)
        : extractListingHeadlines(fetched.body, source.homepageUrl, HEADLINE_SAMPLE_CAP).map(
            (item) => item.headline
          );
    const policy = await decideSourcePolicy(
      scopedDb,
      { ai: deps.ai, repo: deps.repository },
      { canonicalDomain: source.canonicalDomain, description: source.label, sampleHeadlines }
    );
    if (policy.verdict === "approved") {
      await deps.repository.updateSourceValidation(scopedDb, source.id, {
        validationStatus: "approved",
        validationFingerprint: policy.fingerprint
      });
      // A public homepage can be healthy while the reviewed credential is still rejected.
      // Only the credentialed refresh path may clear authentication_failed.
      if (source.healthStatus !== "authentication_failed") {
        await deps.repository.updateSourceHealth(scopedDb, source.id, "healthy");
      }
    } else if (policy.verdict === "rejected") {
      await deps.repository.updateSourceValidation(scopedDb, source.id, {
        validationStatus: "rejected",
        validationFingerprint: policy.fingerprint
      });
    } else {
      // Provider errored mid-check: keep the stored fingerprint (null = don't overwrite)
      // so nothing pretends to have been validated under the new model; retried later.
      await deps.repository.updateSourceValidation(scopedDb, source.id, {
        validationStatus: "needs_revalidation",
        validationFingerprint: null
      });
    }
  }

  let topicsChecked = 0;
  for (const topic of topicsBefore) {
    if (topic.validationStatus === "approved" && topic.validationFingerprint === fingerprint) {
      continue;
    }
    topicsChecked += 1;
    const result = await validateTopic(
      scopedDb,
      { ai: deps.ai },
      { label: topic.label, guidance: topic.guidance }
    );
    if (result.verdict === "approved" || result.verdict === "rejected") {
      await deps.repository.updateTopicValidation(scopedDb, topic.id, {
        validationStatus: result.verdict,
        validationFingerprint: result.fingerprint
      });
    } else {
      await deps.repository.updateTopicValidation(scopedDb, topic.id, {
        validationStatus: "needs_revalidation",
        validationFingerprint: null
      });
    }
  }

  const sourcesAfter = await deps.repository.listSourceValidationStates(scopedDb);
  const topicsAfter = await deps.repository.listTopicValidationStates(scopedDb);
  const sourcesNeedingAttention = sourcesAfter.filter(sourceNeedsAttention).length;
  const topicsNeedingAttention = topicsAfter.filter(topicNeedsAttention).length;
  const attentionBefore = new Set([
    ...sourcesBefore.filter(sourceNeedsAttention).map((source) => `source:${source.id}`),
    ...topicsBefore.filter(topicNeedsAttention).map((topic) => `topic:${topic.id}`)
  ]);
  const transitionedToAttention =
    sourcesAfter.some(
      (source) => sourceNeedsAttention(source) && !attentionBefore.has(`source:${source.id}`)
    ) ||
    topicsAfter.some(
      (topic) => topicNeedsAttention(topic) && !attentionBefore.has(`topic:${topic.id}`)
    );

  deps.logger.info({
    event: "news_revalidation_run",
    sourcesChecked,
    topicsChecked,
    sourcesNeedingAttention,
    topicsNeedingAttention
  });
  return {
    sourcesChecked,
    topicsChecked,
    sourcesNeedingAttention,
    topicsNeedingAttention,
    transitionedToAttention
  };
}
