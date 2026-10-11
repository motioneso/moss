import type { ChatActivityEventDto, TranscriptRecord } from "@moss/shared";

export interface TerminalActionRecord extends ChatActivityEventDto {
  readonly kind: "action_result";
  readonly actionRequestId: string;
  readonly outcome: NonNullable<ChatActivityEventDto["outcome"]>;
}

/** Terminal metadata only: live previews, inputs, artifacts and invalidation payloads stay out. */
export function terminalActionRecord(record: TranscriptRecord): TerminalActionRecord | undefined {
  if (record.kind !== "action_result" || !record.actionRequestId || !record.outcome)
    return undefined;
  return {
    kind: "action_result",
    actionRequestId: record.actionRequestId,
    text: record.text.slice(0, 200),
    outcome: record.outcome,
    ...(record.toolName ? { toolName: record.toolName.slice(0, 120) } : {}),
    ...(record.summary ? { summary: record.summary.slice(0, 200) } : {}),
    ...(record.reason ? { reason: record.reason.slice(0, 500) } : {}),
    ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
    ...(record.sequence === undefined ? {} : { sequence: record.sequence }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs })
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function actionRecordId(value: unknown): string | undefined {
  const id = object(value)?.actionRequestId;
  return typeof id === "string" && id ? id : undefined;
}

export function actionRecords(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Replace the same terminal notification in place, or join it to its original pending card. */
export function mergeTerminalAction(
  activity: readonly unknown[],
  record: TerminalActionRecord
): unknown[] {
  const sameResult = (entry: unknown) =>
    object(entry)?.kind === "action_result" && actionRecordId(entry) === record.actionRequestId;
  const first = activity.findIndex(sameResult);
  if (first >= 0) {
    const previous = object(activity[first])!;
    const sameDecision =
      previous.outcome === record.outcome && previous.decidedBy === record.decidedBy;
    // Recovery knows the terminal decision but may lack the original title/hold duration.
    // Keep richer existing metadata for the same decision; a later rich notification fills gaps.
    const merged = sameDecision ? { ...record, ...previous } : { ...previous, ...record };
    return activity.flatMap((entry, index) =>
      sameResult(entry) ? (index === first ? [merged] : []) : [entry]
    );
  }
  const pending = activity.findIndex(
    (entry) =>
      object(entry)?.kind === "action_request" && actionRecordId(entry) === record.actionRequestId
  );
  const result = [...activity];
  result.splice(pending < 0 ? result.length : pending + 1, 0, record);
  return result;
}
