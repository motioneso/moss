import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  AccessContext,
  DataContextDb,
  DataContextRunner,
  UsefulnessFeedbackSignal
} from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import {
  createUsefulnessFeedbackRouteSchema,
  listUsefulnessFeedbackRouteSchema,
  undoUsefulnessFeedbackRouteSchema,
  updateUsefulnessFeedbackReasonRouteSchema,
  type FeedbackSurface,
  type FeedbackTargetKind,
  type UsefulnessFeedbackDto,
  type UsefulnessFeedbackKind
} from "@moss/shared";

import { sanitizeFeedbackMetadata } from "./metadata.js";
import { parseCreateBody, parseListQuery, parseReasonBody } from "./request-parsing.js";
import { UsefulnessFeedbackRepository } from "./repository.js";
import { compileStoryRelevanceRule, storyRelevanceDirectionForKind } from "./relevance/compile.js";
import { isStoryTargetKind, storyModuleForTargetKind } from "./story-target.js";
import { isAllowedFeedbackPair, type FeedbackTargetVerifierRegistry } from "./target-verifiers.js";

export interface UsefulnessFeedbackRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly registry: FeedbackTargetVerifierRegistry;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly repository?: UsefulnessFeedbackRepository;
  readonly cardSideEffects?: {
    applyDismiss(
      scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0],
      actorUserId: string,
      cardId: string
    ): Promise<void>;
    undoDismissCard(
      scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0],
      actorUserId: string,
      cardId: string
    ): Promise<void>;
  };
  readonly calendarFollowThroughSideEffects?: {
    removeCreatedRefs(
      scopedDb: DataContextDb,
      actorUserId: string,
      metadata: Record<string, unknown>
    ): Promise<string | null>;
  };
  /**
   * Called after a story preference is saved, edited or taken back, so the owning module can
   * refresh what it shows. Deliberately unwired in this slice: #2018 (News) and #2019 (Sports)
   * attach their refresh here, which keeps queue work out of this module while giving them a seam
   * that does not require re-opening this file.
   */
  readonly onStoryPreferenceChanged?: (input: {
    readonly ownerUserId: string;
    readonly targetKind: FeedbackTargetKind;
    readonly targetRef: string;
    readonly change: "created" | "updated" | "removed";
  }) => Promise<void> | void;
  readonly manualMemoryCandidates?: {
    createPendingManualCandidate(
      scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0],
      ownerUserId: string,
      input: {
        readonly targetKind: string;
        readonly targetRef: string;
        readonly excerpt: string;
        readonly episodeId?: string | null;
        readonly provenance?: "volunteered" | "inferred";
      }
    ): Promise<{ readonly id: string }>;
    cancelPendingManualCandidate(
      scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0],
      ownerUserId: string,
      id: string
    ): Promise<boolean>;
  };
}

export function registerUsefulnessFeedbackRoutes(
  server: FastifyInstance,
  dependencies: UsefulnessFeedbackRoutesDependencies
): void {
  const repository = dependencies.repository ?? new UsefulnessFeedbackRepository();

  server.post(
    "/api/me/usefulness-feedback",
    { schema: { response: createUsefulnessFeedbackRouteSchema.response } },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const input = parseCreateBody(request.body);
        if (!isAllowedFeedbackPair(input.targetKind, input.surface, input.kind)) {
          throw new HttpError(400, "Feedback target/action pair is invalid");
        }

        const isStory = isStoryTargetKind(input.targetKind);

        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          // This lookup only ever sees rows the caller already owns, so returning one early can
          // disclose nothing about anyone else, and it keeps a repeated tap from re-running the
          // verifier. Nothing is written on any path below without a successful verification.
          const existing = isStory
            ? await repository.findActiveStoryPreference(
                scopedDb,
                access.actorUserId,
                input.targetKind,
                input.targetRef
              )
            : await repository.findActive(
                scopedDb,
                access.actorUserId,
                input.targetKind,
                input.targetRef,
                input.kind
              );
          if (existing && existing.kind === input.kind) {
            return { feedback: existing, created: false };
          }

          const verifier = dependencies.registry.get(input.targetKind);
          if (!verifier) throw new HttpError(404, "Feedback target not found");
          const verification = await verifier(scopedDb, {
            actorUserId: access.actorUserId,
            targetKind: input.targetKind,
            targetRef: input.targetRef,
            surface: input.surface
          });
          if (!verification) throw new HttpError(404, "Feedback target not found");
          if (input.kind === "remember_this" && !verification.canRemember) {
            throw new HttpError(400, "Feedback target cannot be remembered");
          }
          let effectKind: string | null = null;
          let effectRef: string | null = null;
          if (input.kind === "remember_this") {
            const excerpt = verification.rememberExcerpt?.replace(/\s+/g, " ").trim();
            if (!excerpt || !dependencies.manualMemoryCandidates) {
              throw new HttpError(400, "Feedback target cannot be remembered");
            }
            const candidate =
              await dependencies.manualMemoryCandidates.createPendingManualCandidate(
                scopedDb,
                access.actorUserId,
                {
                  targetKind: input.targetKind,
                  targetRef: input.targetRef,
                  excerpt,
                  provenance: input.targetKind === "chat_message" ? "volunteered" : "inferred"
                }
              );
            effectKind = "memory_candidate";
            effectRef = candidate.id;
          }
          if (input.kind === "dismiss" && input.targetKind === "proactive_card") {
            await dependencies.cardSideEffects?.applyDismiss(
              scopedDb,
              access.actorUserId,
              input.targetRef
            );
            effectKind = "proactive_card_dismissed";
            effectRef = input.targetRef;
          }
          if (input.kind === "not_useful" && input.targetKind === "briefing_item") {
            const removedRef =
              (await dependencies.calendarFollowThroughSideEffects?.removeCreatedRefs(
                scopedDb,
                access.actorUserId,
                verification.metadata ?? {}
              )) ?? null;
            if (removedRef) {
              effectKind = "calendar_follow_through_removed";
              effectRef = removedRef;
            }
          }

          // The opposite direction is retired rather than deleted, so the history stays readable
          // and the one-active-preference-per-story index keeps holding.
          if (existing) await repository.supersede(scopedDb, access.actorUserId, existing.id);

          // Compiling is pure and involves no model call, so a story preference is saved with its
          // rule already attached and this adds no way for saving to fail.
          const metadata = sanitizeFeedbackMetadata(verification.metadata);
          return {
            feedback: await repository.create(scopedDb, {
              ownerUserId: access.actorUserId,
              targetKind: input.targetKind,
              targetRef: input.targetRef,
              surface: input.surface,
              kind: input.kind,
              verification,
              metadata,
              effectKind,
              effectRef,
              reasonText: input.reason ?? null,
              rule: buildStoryRule({
                targetKind: input.targetKind,
                targetRef: input.targetRef,
                kind: input.kind,
                context: metadata,
                reasonText: input.reason ?? null
              })
            }),
            created: true
          };
        });

        if (isStory && result.created) {
          await notifyStoryPreferenceChanged(dependencies, result.feedback, "created");
        }

        return reply
          .code(result.created ? 201 : 200)
          .send({ feedback: serializeFeedback(result.feedback) });
      } catch (error) {
        return handleRouteError(error, reply, {
          invalidRequestMessage: "Usefulness feedback request is invalid"
        });
      }
    }
  );

  server.get<{ Querystring: { module?: string; status?: string } }>(
    "/api/me/usefulness-feedback",
    { schema: listUsefulnessFeedbackRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        // News settings must never show Sports preferences, or the other way round.
        const filters = parseListQuery(request.query);
        const feedback = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.list(scopedDb, access.actorUserId, filters)
        );
        return { feedback: feedback.map(serializeFeedback) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/me/usefulness-feedback/:id/undo",
    { schema: undoUsefulnessFeedbackRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const outcome = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.undo(scopedDb, access.actorUserId, request.params.id, {
            cancelMemoryCandidate: dependencies.manualMemoryCandidates
              ? (candidateId) =>
                  dependencies.manualMemoryCandidates!.cancelPendingManualCandidate(
                    scopedDb,
                    access.actorUserId,
                    candidateId
                  )
              : undefined,
            undoDismissCard: dependencies.cardSideEffects
              ? (cardId) =>
                  dependencies.cardSideEffects!.undoDismissCard(
                    scopedDb,
                    access.actorUserId,
                    cardId
                  )
              : undefined
          })
        );
        if (!outcome) throw new HttpError(404, "Feedback not found");
        // Only tell News or Sports to refresh when the row really moved. Taking back a preference
        // that was already retired changes nothing, so it owes nobody a refresh.
        if (
          outcome.changed &&
          isStoryTargetKind(outcome.feedback.target_kind as FeedbackTargetKind)
        ) {
          await notifyStoryPreferenceChanged(dependencies, outcome.feedback, "removed");
        }
        return { feedback: serializeFeedback(outcome.feedback) };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch<{ Params: { id: string } }>(
    "/api/me/usefulness-feedback/:id",
    // Params and response only, matching the create route: the body is parsed by hand so that a
    // reason is trimmed before its length is judged. Letting the schema check maxLength first
    // would refuse a 500-character reason with a stray space that create happily accepts.
    {
      schema: {
        params: updateUsefulnessFeedbackReasonRouteSchema.params,
        response: updateUsefulnessFeedbackReasonRouteSchema.response
      }
    },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const reason = parseReasonBody(request.body);
        const feedback = await dependencies.dataContext.withDataContext(
          access,
          async (scopedDb) => {
            // Owner-scoped: another person's row is simply not found, which is also what a caller
            // guessing ids should be told.
            const owned = await repository.findOwned(
              scopedDb,
              access.actorUserId,
              request.params.id
            );
            if (!owned || owned.status !== "active") throw new HttpError(404, "Feedback not found");
            if (owned.kind !== "less_like_this") {
              throw new HttpError(400, "Only a Less like this reason can be edited");
            }
            // The rule is rebuilt from the row's own stored story context and the new reason, and
            // written in the same statement, so the two can never disagree.
            return repository.updateReason(
              scopedDb,
              access.actorUserId,
              owned.id,
              reason,
              buildStoryRule({
                targetKind: owned.target_kind as FeedbackTargetKind,
                targetRef: owned.target_ref,
                kind: owned.kind,
                context: owned.metadata_json,
                reasonText: reason
              })
            );
          }
        );
        if (!feedback) throw new HttpError(404, "Feedback not found");
        if (isStoryTargetKind(feedback.target_kind as FeedbackTargetKind)) {
          await notifyStoryPreferenceChanged(dependencies, feedback, "updated");
        }
        return { feedback: serializeFeedback(feedback) };
      } catch (error) {
        return handleRouteError(error, reply, {
          invalidRequestMessage: "Usefulness feedback request is invalid"
        });
      }
    }
  );
}

/**
 * Compiles a saved story preference into a rule, or nothing at all when the row is not a story
 * preference. Briefing, chat and card feedback keeps today's empty rule.
 */
function buildStoryRule(input: {
  readonly targetKind: FeedbackTargetKind;
  readonly targetRef: string;
  readonly kind: UsefulnessFeedbackKind;
  readonly context: Record<string, unknown>;
  readonly reasonText: string | null;
}): ReturnType<typeof compileStoryRelevanceRule> | null {
  const moduleId = storyModuleForTargetKind(input.targetKind);
  const direction = storyRelevanceDirectionForKind(input.kind);
  if (!moduleId || !direction) return null;
  return compileStoryRelevanceRule({
    moduleId,
    direction,
    storyRef: input.targetRef,
    context: input.context,
    reasonText: input.reasonText
  });
}

async function notifyStoryPreferenceChanged(
  dependencies: UsefulnessFeedbackRoutesDependencies,
  feedback: UsefulnessFeedbackSignal,
  change: "created" | "updated" | "removed"
): Promise<void> {
  // Carries ids and the kind of change only. The reason never travels through this seam.
  await dependencies.onStoryPreferenceChanged?.({
    ownerUserId: feedback.owner_user_id,
    targetKind: feedback.target_kind as FeedbackTargetKind,
    targetRef: feedback.target_ref,
    change
  });
}

function serializeFeedback(row: UsefulnessFeedbackSignal): UsefulnessFeedbackDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    targetKind: row.target_kind as FeedbackTargetKind,
    targetRef: row.target_ref,
    surface: row.surface as FeedbackSurface,
    kind: row.kind as UsefulnessFeedbackKind,
    sourceKind: row.source_kind,
    sourceLabel: row.source_label,
    priorityBand: row.priority_band,
    effectKind: row.effect_kind,
    effectRef: row.effect_ref,
    metadata: row.metadata_json,
    status: row.status,
    reason: row.reason_text,
    revision: row.revision,
    ruleVersion: row.rule_version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    resolvedAt: row.resolved_at ? toIsoString(row.resolved_at) : null
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
