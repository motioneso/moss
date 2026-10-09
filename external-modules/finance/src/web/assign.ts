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

/** Checks a typed amount gets before the screen gives up on it (about a minute in all). */
export const MAX_CHECKS = 8;

/** Wait before check number `attempt` (1-based): starts at 2 seconds, then slows down. */
export function checkDelayMs(attempt: number): number {
  return Math.min(2000 * attempt, 10_000);
}

export interface CheckStep {
  /** Per-category count of checks that found a mismatch. */
  counts: Record<string, number>;
  /** Categories that used all their checks. */
  giveUp: string[];
  /** Largest count among categories still waiting; 0 when none wait. */
  retryAttempt: number;
}

/**
 * Advances each category's own check count. Confirmed categories drop out, so one
 * slow save never uses up another category's checks.
 */
export function trackChecks(
  counts: Record<string, number>,
  settled: SettleResult,
  max: number = MAX_CHECKS
): CheckStep {
  const next: Record<string, number> = {};
  const giveUp: string[] = [];
  let retryAttempt = 0;
  for (const id of settled.mismatched) {
    const used = (counts[id] ?? 0) + 1;
    if (used >= max) {
      giveUp.push(id);
    } else {
      next[id] = used;
      retryAttempt = Math.max(retryAttempt, used);
    }
  }
  return { counts: next, giveUp, retryAttempt };
}
