import type { UsefulnessFeedbackSignal } from "@moss/db";
import type {
  FeedbackSurface,
  FeedbackTargetKind,
  UsefulnessFeedbackDto,
  UsefulnessFeedbackKind
} from "@moss/shared";

export function serializeFeedback(row: UsefulnessFeedbackSignal): UsefulnessFeedbackDto {
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
