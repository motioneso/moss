import { createHash } from "node:crypto";
import type { BriefingRun } from "@moss/db";
import { briefingSignalFeedbackItemId } from "./feedback-targets.js";
import type {
  FeedbackTargetVerifier,
  UsefulnessFeedbackRepository
} from "@moss/usefulness-feedback";

import { BriefingsRepository } from "./repository.js";

export function createBriefingsFeedbackTargetVerifier(
  repository: Pick<BriefingsRepository, "getOwnedRunById"> = new BriefingsRepository(),
  feedbackRepository: Pick<UsefulnessFeedbackRepository, "findTarget">
): FeedbackTargetVerifier {
  return async (scopedDb, input) => {
    if (input.targetKind === "briefing_run" && input.surface === "briefing") {
      const run = await repository.getOwnedRunById(scopedDb, input.targetRef);
      if (!run || run.owner_user_id !== input.actorUserId) return null;
      return {
        ownerUserId: input.actorUserId,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        surface: input.surface,
        sourceKind: "briefing",
        sourceLabel: "Briefing",
        approvalTarget: {
          label: run.summary_text,
          version: targetVersion([run.id, run.summary_text])
        },
        metadata: { briefingType: run.briefing_type },
        canRemember: false
      };
    }

    if (input.targetKind === "briefing_item") {
      const target = await feedbackRepository.findTarget(
        scopedDb,
        input.actorUserId,
        input.targetKind,
        input.targetRef,
        input.surface
      );
      if (!target) return null;
      const runId = target.metadata_json.briefingRunId;
      const run =
        typeof runId === "string" ? await repository.getOwnedRunById(scopedDb, runId) : null;
      const label =
        run?.owner_user_id === input.actorUserId ? itemLabel(run, input.targetRef) : null;
      return {
        ownerUserId: input.actorUserId,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        surface: input.surface,
        ...(label && run
          ? { approvalTarget: { label, version: targetVersion([run.id, input.targetRef, label]) } }
          : {}),
        sourceKind: target.source_kind ?? undefined,
        sourceLabel: target.source_label ?? undefined,
        priorityBand: target.priority_band ?? undefined,
        metadata: target.metadata_json,
        canRemember: false
      };
    }

    return null;
  };
}

function targetVersion(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Find the complete display text in its owned source record, never in caller metadata. */
function itemLabel(run: BriefingRun, targetRef: string): string | null {
  const labels = new Set<string>();
  for (const [source, key] of [
    ["calendar", "calendarSignals"],
    ["email", "emailSignals"]
  ] as const) {
    const signals = run.source_metadata[key];
    if (!Array.isArray(signals)) continue;
    for (const entry of signals) {
      if (!entry || typeof entry !== "object") continue;
      const signal = entry as Record<string, unknown>;
      if (typeof signal.type !== "string" || typeof signal.summary !== "string") continue;
      if (briefingSignalFeedbackItemId(source, signal.type, signal.summary) === targetRef)
        labels.add(signal.summary);
    }
  }
  const payload = run.source_metadata.structuredPayload as
    | { catchUp?: { entries?: unknown } }
    | undefined;
  const entries = payload?.catchUp?.entries;
  if (Array.isArray(entries))
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        entry.id !== targetRef ||
        typeof entry.summary !== "string"
      )
        continue;
      labels.add(
        typeof entry.senderName === "string"
          ? `${entry.senderName}\n${entry.summary}`
          : entry.summary
      );
    }
  return labels.size ? [...labels].join("\n\n") : null;
}
