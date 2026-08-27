import type { FeedbackTargetVerifier } from "./target-verifiers.js";
import type { UsefulnessFeedbackRepository } from "./repository.js";
import { isStoryTargetKind, sanitizeStoryTargetMetadata } from "./story-target.js";

/**
 * Confirms that a story the caller is giving feedback on really came from that caller's own News or
 * Sports results.
 *
 * The only source of truth is the target row the owning module registered earlier for this owner,
 * story and surface. Nothing the client sends about the story is trusted, and no story is ever
 * remembered, so `canRemember` stays false. This lives in the feedback module rather than in News
 * or Sports because both modules register through the same table and neither owns the other's
 * kinds.
 */
export function createStoryFeedbackTargetVerifier(
  feedbackRepository: Pick<UsefulnessFeedbackRepository, "findTarget">
): FeedbackTargetVerifier {
  return async (scopedDb, input) => {
    if (!isStoryTargetKind(input.targetKind)) return null;

    const target = await feedbackRepository.findTarget(
      scopedDb,
      input.actorUserId,
      input.targetKind,
      input.targetRef,
      input.surface
    );
    if (!target) return null;

    return {
      ownerUserId: input.actorUserId,
      targetKind: input.targetKind,
      targetRef: input.targetRef,
      surface: input.surface,
      sourceKind: target.source_kind ?? undefined,
      sourceLabel: target.source_label ?? undefined,
      priorityBand: target.priority_band ?? undefined,
      metadata: sanitizeStoryTargetMetadata(target.metadata_json),
      canRemember: false
    };
  };
}
