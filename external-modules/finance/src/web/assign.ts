// external-modules/finance/src/web/assign.ts
//
// #3174: pure helpers for typing an assigned amount in place on Budget.
// `pending` maps a category id to the cents the user typed and the server
// has not confirmed yet.

export type PendingAssignments = Record<string, number>;

/** What a pending amount changes on a line: the typed total replaces the server's. */
export function applyPending(
  line: { id: string; assigned: number; available: number },
  pending: PendingAssignments
): { assigned: number; available: number } {
  const typed = pending[line.id];
  if (typed === undefined) return { assigned: line.assigned, available: line.available };
  return { assigned: typed, available: line.available + (typed - line.assigned) };
}

export interface SettleResult {
  /** Category ids whose typed amount the server now shows. */
  confirmed: string[];
  /** Category ids the server still shows at another amount. */
  mismatched: string[];
}

/** Compares each pending amount with what the server returned. */
export function settlePending(
  pending: PendingAssignments,
  serverAssigned: Record<string, number>
): SettleResult {
  const confirmed: string[] = [];
  const mismatched: string[] = [];
  for (const [id, typed] of Object.entries(pending)) {
    if ((serverAssigned[id] ?? 0) === typed) confirmed.push(id);
    else mismatched.push(id);
  }
  return { confirmed, mismatched };
}
