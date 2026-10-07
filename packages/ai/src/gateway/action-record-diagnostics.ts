const reported = new Set<string>();
const MAX_REPORTED_ACTIONS = 1_000;

/** Shared bounded dedupe for the same record crossing retries and delivery layers. */
export function reportActionRecordFailure(actionRequestId: string): void {
  if (reported.has(actionRequestId)) return;
  if (reported.size >= MAX_REPORTED_ACTIONS) reported.delete(reported.values().next().value!);
  reported.add(actionRequestId);
  // The error, input, tool result, actor and conversation never enter this diagnostic.
  console.warn("action_record_delivery_failed", { actionRequestId });
}
