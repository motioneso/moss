import type { PgBoss } from "pg-boss";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult, ToolSummarize } from "@moss/module-sdk";

import type {
  NewsAiPort,
  NewsFetchPort,
  NewsSafeFetchPort,
  NewsWebSearchPort
} from "./discovery/ports.js";
import type { NewsCredentialStore } from "./credential-repository.js";
import { validateTopic } from "./discovery/policy-validation.js";
import { resolveSourceInput, type SourceResolutionResult } from "./discovery/source-resolution.js";
import { normalizePublisherDomain } from "./personalization-domain.js";
import {
  NewsDuplicateSourceError,
  NewsPersonalizationLimitError
} from "./personalization-repository.js";
import {
  cleanTopic,
  confirmSourceFromPreview,
  triggerNewsRefresh,
  type NewsPersonalizationStore,
  type NewsSourcePreviewStore
} from "./personalization-routes.js";

/**
 * Assistant-chat surface for news personalization (#975 Slice 4). Mirrors the
 * REST routes (`personalization-routes.ts`) over the SAME repository and shared
 * preview store, so a source previewed in chat can be confirmed over REST and
 * vice versa. Six tools total: preview/confirm (Task 7) plus removeSource,
 * addTopic, removeTopic, addExclusion (Task 8) — source edit and exclusion
 * removal stay REST-only per the approved plan.
 *
 * Deferred-deps seam mirrors `briefing-tool.ts`: the manifest is static
 * import-time data, but the discovery ports/boss/repository only exist once
 * the composition root runs — `registerNewsRoutes` calls
 * `configureNewsChatTools` during boot, strictly before any chat request can
 * reach these executes.
 */
export interface NewsChatToolDependencies {
  readonly previews: NewsSourcePreviewStore;
  readonly discovery: {
    readonly fetch: NewsSafeFetchPort;
    /** #2282: optional here so existing test fakes keep working; the composition root always passes it. */
    readonly fetchWithOptions?: NewsFetchPort;
    readonly search: NewsWebSearchPort;
    readonly ai: NewsAiPort;
  };
  readonly availability: {
    hasJsonModel(scopedDb: DataContextDb): Promise<boolean>;
    hasWebSearch(scopedDb: DataContextDb): Promise<boolean>;
  };
  readonly boss: PgBoss | null;
  readonly repository: NewsPersonalizationStore;
  readonly credentials?: Pick<NewsCredentialStore, "readStatuses">;
}

let deps: NewsChatToolDependencies | undefined;

export function configureNewsChatTools(config: NewsChatToolDependencies): void {
  deps = config;
}

/** Queue a refresh after the gateway has completed its normal confirmation flow. */
export const newsRefreshNewsExecute: ToolExecute = async (
  scopedDb,
  _input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const queued = await triggerNewsRefresh(scopedDb, d.repository, d.boss, ctx.actorUserId);
  return { data: { status: queued ? "queued" : "accepted", asynchronous: true } };
};

export const summarizeNewsRefresh: ToolSummarize = () => "Refresh news";

function requireDeps(): NewsChatToolDependencies {
  if (!deps) {
    throw new Error(
      "news chat tools used before configureNewsChatTools ran (composition-root bug)"
    );
  }
  return deps;
}

function credentialedSourceGuidance(
  healthStatus:
    | "healthy"
    | "authentication_failed"
    | "temporarily_unavailable"
    | "unsupported"
    | "disabled",
  credentialStatus: "configured" | "revoked" | "not_configured"
): string {
  if (credentialStatus === "not_configured") {
    return "No key is configured. Connect one in News settings.";
  }
  switch (healthStatus) {
    case "authentication_failed":
      return "Authentication failed. Replace the key in News settings.";
    case "disabled":
      return "Access is disabled. Replace the key in News settings.";
    case "temporarily_unavailable":
      return "The publisher is temporarily unavailable. Try again later.";
    case "unsupported":
      return "This publisher is unsupported. Choose another source.";
    default:
      return "This source is connected and healthy.";
  }
}

/** Read-only, display-safe source diagnostics. It never reads an envelope or provider response. */
export const newsCredentialedSourceStatusExecute: ToolExecute = async (
  scopedDb,
  _input,
  _ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const [sources, credentials] = await Promise.all([
    d.repository.listCustomSources(scopedDb),
    d.credentials?.readStatuses(scopedDb) ?? Promise.resolve([])
  ]);
  const credentialBySourceId = new Map(credentials.map((entry) => [entry.sourceId, entry]));
  return {
    data: {
      sources: sources.map((source) => {
        const credential = credentialBySourceId.get(source.id);
        return {
          sourceId: source.id,
          label: source.label,
          domain: source.canonicalDomain,
          healthStatus: source.healthStatus,
          credentialStatus: credential?.status ?? "not_configured",
          guidance: credentialedSourceGuidance(
            source.healthStatus,
            credential?.status ?? "not_configured"
          )
        };
      })
    }
  };
};

/** Benign resolution failures become tool data the model can relay — never throws. */
function describeResolutionFailure(result: SourceResolutionResult): string {
  if (result.status === "rejected") {
    switch (result.reason) {
      case "policy":
        return "That publisher is not allowed by content policy.";
      case "redirected":
        return "That address redirects to a different site; try the address it sends you to.";
      case "invalid_input":
        return "That doesn't look like a news publisher URL or name.";
      case "not_https":
        return "Publisher sites must be reachable over HTTPS.";
      case "unreachable":
        return "Could not reach or verify that publisher.";
      case "blocked":
        return "That publisher's site does not allow automatic access, so it can't be added.";
    }
  }
  return "Source discovery is currently unavailable — try again later.";
}

/**
 * `news.previewSource`: read-risk verification pass. Output NEVER includes
 * `feedUrl` or `validationFingerprint` — provider/model-derived material stays
 * server-side in the preview store; confirm re-reads the stored candidate.
 */
export const newsPreviewSourceExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const rawInput = (input as { source?: unknown }).source;
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!raw) return { data: { error: "Provide a publisher URL or name to preview." } };

  const [hasJsonModel, hasWebSearch] = await Promise.all([
    d.availability.hasJsonModel(scopedDb),
    d.availability.hasWebSearch(scopedDb)
  ]);
  if (!hasJsonModel) {
    return { data: { error: "Custom news sources require a configured AI model." } };
  }
  const result = await resolveSourceInput(
    scopedDb,
    { ...d.discovery, repo: d.repository },
    { raw, hasWebSearch }
  );
  if (result.status !== "ok" && result.status !== "ambiguous") {
    return { data: { error: describeResolutionFailure(result) } };
  }

  // Chat previews never target a replacement — edit stays REST-only.
  const confirmationId = d.previews.put({
    ownerUserId: ctx.actorUserId,
    candidates: result.candidates,
    replaceSourceId: null,
    createdAt: Date.now()
  });
  const existing = await d.repository.listCustomSources(scopedDb);
  const duplicate = result.candidates
    .map((candidate) =>
      existing.find((source) => source.canonicalDomain === candidate.canonicalDomain)
    )
    .find(Boolean);
  return {
    data: {
      confirmationId,
      candidates: result.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        label: candidate.label,
        domain: candidate.canonicalDomain,
        ...(candidate.redirectNote ? { redirectNote: candidate.redirectNote } : {})
      })),
      ...(duplicate ? { duplicateOfSourceId: duplicate.id } : {})
    }
  };
};

/**
 * `news.confirmSource`: always confirm-gated (no actionFamilyId in the
 * manifest, so the gateway never promotes it past the owner prompt). The
 * resubmitted label/domain are the tamper check against the stored candidate —
 * see `confirmSourceFromPreview`.
 */
export const newsConfirmSourceExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const body = input as {
    confirmationId: string;
    candidateId?: string;
    label: string;
    domain: string;
  };
  const outcome = await confirmSourceFromPreview(
    scopedDb,
    { previews: d.previews, repository: d.repository, boss: d.boss },
    ctx.actorUserId,
    {
      confirmationId: body.confirmationId,
      candidateId: body.candidateId,
      expected: { label: body.label, domain: body.domain }
    }
  );
  if (!outcome.ok) return { data: { error: outcome.message } };
  // Echo display fields only — never the stored fingerprint/feedUrl.
  return {
    data: { source: { label: outcome.source.label, domain: outcome.source.canonicalDomain } }
  };
};

/** Confirmation prompt text comes from tool INPUT only — execute hasn't run yet. */
export const summarizeNewsConfirmSource: ToolSummarize = (input) => {
  const body = input as { label?: unknown; domain?: unknown };
  const label = typeof body.label === "string" ? body.label : "custom source";
  const domain = typeof body.domain === "string" ? body.domain : "unknown domain";
  return `Add news source "${label}" (${domain})`;
};

// ---------------------------------------------------------------------------
// #975 Task 8 — the remaining personalization write tools. Each mirrors its
// REST route's write path exactly (same repository calls, same refresh/prune
// side effects) and maps benign failures to `{data:{error}}` the model can
// relay. Domain errors the REST layer turns into 400/409 (limit, duplicate)
// come through as their existing human-readable messages — REST parity.
// ---------------------------------------------------------------------------

function stringField(input: unknown, key: string): string {
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Limit/duplicate are benign domain outcomes, not violations — relay as data. */
function describeBenignWriteError(error: unknown): string | null {
  if (error instanceof NewsPersonalizationLimitError) return error.message;
  if (error instanceof NewsDuplicateSourceError) return error.message;
  return null;
}

/**
 * `news.removeSource`: mirrors DELETE /api/news/sources/:id. The list lookup
 * doubles as the ownership check — RLS hides other owners' rows, so a
 * cross-owner id is indistinguishable from a nonexistent one (friendly
 * not-found, no effect) and garbage ids never reach a uuid cast.
 */
export const newsRemoveSourceExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the id of the news source to remove." } };
  const source = (await d.repository.listCustomSources(scopedDb)).find(
    (item) => item.id === sourceId
  );
  if (!source) return { data: { error: "That news source was not found." } };
  const removed = await d.repository.deleteCustomSource(scopedDb, sourceId);
  if (removed) {
    await triggerNewsRefresh(scopedDb, d.repository, d.boss, ctx.actorUserId, () =>
      d.repository.pruneSnapshotDomain(scopedDb, source.canonicalDomain)
    );
  }
  return { data: { removed } };
};

export const summarizeNewsRemoveSource: ToolSummarize = (input) => {
  const sourceId = stringField(input, "sourceId") || "unknown id";
  return `Remove followed news source ${sourceId}`;
};

/**
 * `news.addTopic`: mirrors POST /api/news/topics — same web-search gate,
 * policy validation, and fingerprint persistence. Policy/availability
 * outcomes are benign data errors here (the REST route's 503/422).
 */
export const newsAddTopicExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const label = stringField(input, "label");
  if (!label) return { data: { error: "Provide a topic label to follow." } };
  // Do not read `guidance` off `input` even though the schema dropped it: the gateway validator
  // deliberately does not strip undeclared keys (input-validation.ts), so a model could still emit
  // one. guidance is free text later framed into prompts, so the execute fn — not the schema — is
  // the only real gate. Assistant-created topics always persist guidance as null.
  const topicInput = cleanTopic({ label, guidance: undefined });
  if (!(await d.availability.hasWebSearch(scopedDb))) {
    return { data: { error: "Topic discovery requires a configured web search provider." } };
  }
  const policy = await validateTopic(scopedDb, { ai: d.discovery.ai }, topicInput);
  if (policy.verdict === "unavailable") {
    return { data: { error: "Topic validation is currently unavailable — try again later." } };
  }
  if (policy.verdict === "rejected") {
    return { data: { error: "That topic is not allowed by content policy." } };
  }
  try {
    const topic = await d.repository.createCustomTopic(scopedDb, {
      ...topicInput,
      validationFingerprint: policy.fingerprint
    });
    await triggerNewsRefresh(scopedDb, d.repository, d.boss, ctx.actorUserId);
    // Echo display fields only — the validation fingerprint stays server-side.
    return { data: { topic: { id: topic.id, label: topic.label } } };
  } catch (error) {
    const benign = describeBenignWriteError(error);
    if (benign) return { data: { error: benign } };
    throw error;
  }
};

export const summarizeNewsAddTopic: ToolSummarize = (input) => {
  const label = stringField(input, "label") || "custom topic";
  return `Follow news topic "${label}"`;
};

/** `news.removeTopic`: mirrors DELETE /api/news/topics/:id (same RLS-as-not-found shape as removeSource). */
export const newsRemoveTopicExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const topicId = stringField(input, "topicId");
  if (!topicId) return { data: { error: "Provide the id of the news topic to remove." } };
  const topic = (await d.repository.listCustomTopics(scopedDb)).find((item) => item.id === topicId);
  if (!topic) return { data: { error: "That news topic was not found." } };
  const removed = await d.repository.deleteCustomTopic(scopedDb, topicId);
  if (removed) {
    await triggerNewsRefresh(scopedDb, d.repository, d.boss, ctx.actorUserId);
  }
  return { data: { removed } };
};

export const summarizeNewsRemoveTopic: ToolSummarize = (input) => {
  const topicId = stringField(input, "topicId") || "unknown id";
  return `Remove followed news topic ${topicId}`;
};

/**
 * `news.addExclusion`: mirrors POST /api/news/source-exclusions — the same
 * reject-by-default domain normalization, then create + refresh with the
 * snapshot prune. Duplicates are idempotent in the repository (returns the
 * existing row), so only the limit error needs benign mapping.
 */
export const newsAddExclusionExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const d = requireDeps();
  const raw = stringField(input, "domain");
  if (!raw) return { data: { error: "Provide a publisher domain to exclude." } };
  const normalized = normalizePublisherDomain(raw);
  if (!normalized.ok) {
    return {
      data: {
        error: `That doesn't look like a valid publisher domain (${normalized.reason.replace(/_/g, " ")}).`
      }
    };
  }
  try {
    const exclusion = await d.repository.createExclusion(scopedDb, normalized.domain);
    await triggerNewsRefresh(scopedDb, d.repository, d.boss, ctx.actorUserId, () =>
      d.repository.pruneSnapshotDomain(scopedDb, normalized.domain)
    );
    return { data: { exclusion: { id: exclusion.id, domain: exclusion.canonicalDomain } } };
  } catch (error) {
    const benign = describeBenignWriteError(error);
    if (benign) return { data: { error: benign } };
    throw error;
  }
};

export const summarizeNewsAddExclusion: ToolSummarize = (input) => {
  const domain = stringField(input, "domain") || "unknown domain";
  return `Exclude news publisher "${domain}"`;
};
