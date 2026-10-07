import type { TranscriptRecord } from "./chat-api.js";

/** An approval decision is not a claim that the subsequent operation succeeded. */
export function actionApprovalOutcome(
  record: Pick<TranscriptRecord, "outcome" | "decidedBy">
): string | null {
  if (record.decidedBy === "timeout") return "Timed out";
  if (record.decidedBy === "cancelled") return "Cancelled";
  if (record.decidedBy !== "person") return null;
  if (record.outcome === "denied") return "You declined";
  return record.outcome ? "Approved" : null;
}
