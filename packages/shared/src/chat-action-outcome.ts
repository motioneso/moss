import type { TranscriptRecord } from "./chat-api.js";

/** An approval decision is not a claim that the subsequent operation succeeded. */
export function actionApprovalOutcome(
  record: Pick<TranscriptRecord, "outcome" | "decidedBy">
): string | null {
  if (record.decidedBy === "timeout") return "Timed out";
  if (record.decidedBy === "cancelled") return "Cancelled";
  if (record.decidedBy !== "person") return null;
  if (record.outcome === "denied") return "You declined";
  if (record.outcome === "error") return "Approved, but it didn’t go through";
  return record.outcome ? "Approved" : null;
}

/** Only fixed plain explanations reach the quiet row; never echo a tool's error payload. */
function approvalFailureReason(reason: string | undefined): string {
  const reasons: readonly (readonly [string, string])[] = [
    ["approval_changed:", "The item changed while you were deciding."],
    ["unknown_route:", "The action or item is no longer available."],
    ["consent_off:", "Access to this information is turned off."],
    ["not_ready:", "The app is not ready yet."],
    ["invalid_call_binding:", "This approval no longer matches the request."],
    ["blocked:", "This action is not available through chat."]
  ];
  return (
    reasons.find(([prefix]) => reason?.startsWith(prefix))?.[1] ?? "The app reported a problem."
  );
}

export function actionApprovalText(
  record: Pick<TranscriptRecord, "outcome" | "decidedBy" | "summary" | "reason">
): string | null {
  const outcome = actionApprovalOutcome(record);
  if (!outcome) return null;
  return [
    outcome,
    record.summary,
    record.outcome === "error" ? approvalFailureReason(record.reason) : null
  ]
    .filter(Boolean)
    .join(" · ");
}
