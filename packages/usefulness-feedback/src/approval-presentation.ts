import { assertDataContextDb } from "@moss/db";
import {
  approvalChoice,
  approvalText,
  presentApprovalFields,
  type RouteApprovalPresentation
} from "@moss/module-sdk";
import { parseSignalBody } from "./request-parsing.js";
import { verifyFeedbackTarget, type FeedbackTargetVerifierRegistry } from "./target-verifiers.js";

let registry: FeedbackTargetVerifierRegistry | undefined;
/** Bound by the same composition registration as the route; every lookup still uses its actor. */
export function configureUsefulnessFeedbackPresentation(
  value: FeedbackTargetVerifierRegistry | undefined
): void {
  registry = value;
}

export const usefulnessFeedbackPresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  if (
    !registry ||
    Object.keys(input.params).length ||
    (input.query && Object.keys(input.query).length)
  )
    return null;
  const parsed = parseSignalBody(input.body);
  const verified = await verifyFeedbackTarget(registry, db, {
    actorUserId: ctx.actorUserId,
    targetKind: parsed.targetKind,
    targetRef: parsed.targetRef,
    surface: parsed.surface
  });
  if (!verified.approvalTarget?.label || !verified.approvalTarget.version) return null;
  const fields = presentApprovalFields(
    input.body,
    {
      kind: {
        label: "Feedback",
        present: approvalChoice({
          more_like_this: "More like this",
          too_much: "Too much",
          wrong_priority: "Wrong priority",
          not_useful: "Not useful",
          dismiss: "Dismiss"
        })
      },
      surface: {
        label: "Shown in",
        present: approvalChoice({
          chat: "Chat",
          briefing: "Briefing",
          today: "Today",
          proactive: "Proactive suggestions"
        })
      },
      targetKind: {
        label: "Item type",
        present: approvalChoice({
          chat_message: "Chat message",
          briefing_run: "Briefing",
          briefing_item: "Briefing item",
          proactive_card: "Proactive suggestion"
        })
      },
      targetRef: {
        label: "Item",
        present: (value) => (value === parsed.targetRef ? verified.approvalTarget!.label : null)
      },
      reason: { label: "Reason", present: approvalText }
    },
    ["kind", "surface", "targetKind", "targetRef"]
  );
  return fields
    ? {
        target: verified.approvalTarget.label,
        fields,
        version: JSON.stringify([
          parsed.targetKind,
          parsed.targetRef,
          verified.approvalTarget.version
        ])
      }
    : null;
};
