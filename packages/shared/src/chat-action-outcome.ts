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
  if (reason === "invalid_input" || reason?.startsWith("invalid_input:")) {
    return "Some action details need correcting before this can run.";
  }
  const reasons: readonly (readonly [string, string])[] = [
    ["approval_changed:", "The item changed before the action could finish."],
    ["unknown_route:", "The action or item is no longer available."],
    ["consent_off:", "Access to this information is turned off."],
    ["not_ready:", "The app is not ready yet."],
    ["invalid_call_binding:", "The action no longer matches the original request."],
    ["blocked:", "This action is not available through chat."]
  ];
  return (
    reasons.find(([prefix]) => reason?.startsWith(prefix))?.[1] ?? "The app reported a problem."
  );
}

export function actionOutcomeText(
  record: Pick<TranscriptRecord, "outcome" | "decidedBy" | "summary" | "reason">
): string | null {
  const outcome = actionApprovalOutcome(record);
  if (!outcome) {
    if (record.outcome === "executed") return record.summary ? `Done: ${record.summary}` : "Done";
    if (record.outcome === "error") {
      return `${record.summary ?? "The action"} didn’t go through · ${approvalFailureReason(record.reason)}`;
    }
    // Permission and policy refusal are not observed execution or the user's decision.
    if (record.outcome === "allowed")
      return record.summary ? `Allowed: ${record.summary}` : "Allowed";
    if (record.outcome === "denied")
      return record.summary ? `Not allowed: ${record.summary}` : "Not allowed";
    return null;
  }
  return [
    outcome,
    record.summary,
    record.outcome === "error" ? approvalFailureReason(record.reason) : null
  ]
    .filter(Boolean)
    .join(" · ");
}
