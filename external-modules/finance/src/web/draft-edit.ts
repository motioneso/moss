// external-modules/finance/src/web/draft-edit.ts
//
// #3181: pure helpers for typing a plan amount in place on the first-budget draft.
// `pending` maps a category key to the cents the user typed and the worker has not
// confirmed yet. The screen shows pending amounts at once, and the header total is
// always recomputed from the lines it shows, so the two cannot disagree.

export type PendingPlans = Record<string, number>;

interface PlanLine {
  categoryKey: string;
  planCents: number;
  dropped: boolean;
}

interface PlanDraft<L extends PlanLine> {
  monthlyIncomeCents: number;
  totalCents: number;
  unplannedCents: number;
  groups: { name: string; lines: L[] }[];
}

/**
 * The draft as the screen shows it: each pending amount replaces the stored plan (and
 * brings a dropped line back), and the total and unplanned amount are summed again from
 * the shown lines.
 */
export function showPending<L extends PlanLine, D extends PlanDraft<L>>(
  draft: D,
  pending: PendingPlans
): D {
  let totalCents = 0;
  const groups = draft.groups.map((group) => ({
    ...group,
    lines: group.lines.map((line) => {
      const typed = pending[line.categoryKey];
      const shown = typed === undefined ? line : { ...line, planCents: typed, dropped: false };
      if (!shown.dropped) totalCents += shown.planCents;
      return shown;
    })
  }));
  return {
    ...draft,
    groups,
    totalCents,
    unplannedCents: draft.monthlyIncomeCents - totalCents
  };
}

/** Pending categories whose typed amount the stored draft now shows. */
export function confirmedPlans(
  pending: PendingPlans,
  draft: { groups: { lines: PlanLine[] }[] }
): string[] {
  const stored = new Map<string, PlanLine>();
  for (const group of draft.groups)
    for (const line of group.lines) stored.set(line.categoryKey, line);
  return Object.entries(pending)
    .filter(([key, typed]) => {
      const line = stored.get(key);
      return line !== undefined && !line.dropped && line.planCents === typed;
    })
    .map(([key]) => key);
}

/** How long a typed amount waits for the worker before the screen puts the old one back. */
export const PENDING_GIVE_UP_MS = 60_000;
