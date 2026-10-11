import { createHash } from "node:crypto";
import type { FeedbackTargetVerification, FeedbackTargetVerifier } from "@moss/usefulness-feedback";

import type { CardRepository } from "./card-repository.js";

const SOURCE_LABELS: Record<string, string> = {
  tasks: "Tasks",
  calendar: "Calendar",
  email: "Email",
  notes: "Notes"
};

const REMEMBER_EXCERPT_MAX = 300;

export function makeProactiveCardVerifier(
  cardRepository: Pick<CardRepository, "findById">
): FeedbackTargetVerifier {
  return async (scopedDb, input): Promise<FeedbackTargetVerification | null> => {
    const card = await cardRepository.findById(scopedDb, input.actorUserId, input.targetRef);
    if (!card) return null;

    const raw = `${card.title} — ${card.summary ?? ""}`;
    const excerpt = raw.length <= REMEMBER_EXCERPT_MAX ? raw : raw.slice(0, REMEMBER_EXCERPT_MAX);
    const canRemember = (card.summary?.length ?? 0) <= REMEMBER_EXCERPT_MAX;

    return {
      ownerUserId: card.owner_user_id,
      targetKind: "proactive_card",
      targetRef: card.id,
      surface: "proactive",
      approvalTarget: {
        label: `${card.title}\n${card.summary ?? ""}`,
        version: createHash("sha256")
          .update(
            JSON.stringify([
              card.id,
              card.owner_user_id,
              card.title,
              card.summary,
              card.status,
              card.source_ref_hash
            ])
          )
          .digest("hex")
      },
      sourceKind: card.source,
      sourceLabel: SOURCE_LABELS[card.source] ?? card.source,
      priorityBand: card.priority_band as FeedbackTargetVerification["priorityBand"],
      canRemember,
      rememberExcerpt: canRemember ? excerpt : undefined
    };
  };
}
