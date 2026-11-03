// external-modules/finance/src/web/attention-model.ts
//
// Pure figures for the Budget "This month" strip and the "Needs your attention" list.
// Everything here reads data the Budget, bills and transactions reads already return.
import type { Line } from "./budget-table";
import { billMatchCandidates } from "./bill-match-candidates";
import { occurrenceDate } from "./bill-occurrence";
import type { BillsView, Occurrence } from "./screens/upcoming";

/** Groups that never count as spending. Income and Transfers are not envelopes at all. */
const NOT_SPENDING: ReadonlySet<string> = new Set(["Savings"]);

export const ATTENTION_DAYS = 7;
export const VISIBLE_ROWS = 5;

export interface SpendingLine extends Line {
  group: string;
}

export function spendingLines(groups: { name: string; lines: Line[] }[]): SpendingLine[] {
  return groups
    .filter((group) => !NOT_SPENDING.has(group.name))
    .flatMap((group) => group.lines.map((line) => ({ ...line, group: group.name })))
    .filter((line) => !line.archived);
}

export interface StripFigures {
  spentCents: number;
  assignedCents: number;
  leftCents: number;
  leftCount: number;
  overspentCents: number;
  overspentCount: number;
  worstOverspent: string | null;
}

export function stripFigures(lines: readonly SpendingLine[]): StripFigures {
  const over = lines.filter((line) => line.available < 0);
  const left = lines.filter((line) => line.available > 0);
  const worst = [...over].sort((a, b) => a.available - b.available)[0];
  return {
    spentCents: lines.reduce((sum, line) => sum + line.spent, 0),
    assignedCents: lines.reduce((sum, line) => sum + line.assigned, 0),
    leftCents: left.reduce((sum, line) => sum + line.available, 0),
    leftCount: left.length,
    overspentCents: over.reduce((sum, line) => sum + line.available, 0),
    overspentCount: over.length,
    worstOverspent: worst?.name ?? null
  };
}

/** The last calendar day of a YYYY-MM month as YYYY-MM-DD. */
export function monthEnd(month: string): string {
  const days = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)
  ).getUTCDate();
  return `${month}-${String(days).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** The window the bills read covers: the whole month, plus the coming week for this month. */
export function billsWindow(month: string, today: string): { from: string; to: string } {
  const end = monthEnd(month);
  const isCurrent = today.slice(0, 7) === month;
  const soon = addDays(today, ATTENTION_DAYS);
  return { from: `${month}-01`, to: isCurrent && soon > end ? soon : end };
}

const open = (o: Occurrence) => o.state === "projected" || o.state === "review";

export interface BillsDue {
  cents: number;
  count: number;
  pastDue: number;
  next: string | null;
}

/** Bills in the month that are neither posted nor skipped. */
export function billsDue(view: BillsView, month: string, today: string): BillsDue {
  const inMonth = view.occurrences.filter(
    (o) => open(o) && occurrenceDate(o).slice(0, 7) === month
  );
  const upcoming = inMonth
    .map(occurrenceDate)
    .filter((date) => date >= today)
    .sort()[0];
  return {
    cents: inMonth.reduce((sum, o) => sum + o.expectedCents, 0),
    count: inMonth.length,
    pastDue: inMonth.filter((o) => occurrenceDate(o) < today).length,
    next: upcoming ?? null
  };
}

export type AttentionRow =
  | {
      kind: "bill";
      key: string;
      occurrence: Occurrence;
      pastDue: boolean;
      /** The posted transaction that fits, when there is one. */
      match: { transactionId: string; cents: number; date: string } | null;
    }
  | {
      kind: "overspent";
      key: string;
      line: SpendingLine;
      deficitCents: number;
      /** The category the money comes from, and how much it can give. */
      source: { id: string; name: string; availableCents: number } | null;
      partial: boolean;
    }
  | {
      kind: "predicted";
      key: string;
      count: number;
      names: string[];
      first: PredictedTx | null;
      /** Set only when the group can be confirmed as listed. */
      confirmable: PredictedTx[] | null;
    };

export interface PredictedTx {
  id: string;
  name: string;
  writeRevision?: string;
  categoryName: string | null;
  amountCents: number;
}

/** The posted expense that fits an open bill: same account, same amount, within the week. */
export function fittingPost(
  view: BillsView,
  o: Occurrence
): { transactionId: string; cents: number; date: string } | null {
  if (o.state === "review" && o.transactionId) {
    const tx = view.transactions.find((t) => t.id === o.transactionId);
    return {
      transactionId: o.transactionId,
      cents: o.actualCents ?? tx?.amountCents ?? o.expectedCents,
      date: tx?.date ?? occurrenceDate(o)
    };
  }
  if (o.state !== "projected") return null;
  const claimed = new Set(view.occurrences.map((x) => x.transactionId).filter(Boolean));
  const planned = Date.parse(`${occurrenceDate(o)}T00:00:00Z`);
  const hit = billMatchCandidates(
    view.transactions.filter((t) => !claimed.has(t.id)),
    o
  ).find(
    (t) =>
      t.amountCents === o.expectedCents &&
      Math.abs(Date.parse(`${t.date}T00:00:00Z`) - planned) <= ATTENTION_DAYS * 86400000
  );
  return hit ? { transactionId: hit.id, cents: hit.amountCents, date: hit.date } : null;
}

export function coverSource(
  lines: readonly SpendingLine[],
  line: SpendingLine,
  deficit: number
): { id: string; name: string; availableCents: number } | null {
  const pool = lines.filter((other) => other.id !== line.id && other.available > 0);
  const full = pool.filter((other) => other.available >= deficit);
  const best = (full.length ? full : pool).sort((a, b) => b.available - a.available)[0];
  return best ? { id: best.id, name: best.name, availableCents: best.available } : null;
}

export function attentionRows(input: {
  month: string;
  currentMonth: string;
  bills: BillsView | null;
  lines: readonly SpendingLine[];
  predicted: { total: number; rows: PredictedTx[] } | null;
}): AttentionRow[] {
  if (input.month !== input.currentMonth) return [];
  const rows: AttentionRow[] = [];
  const today = input.bills?.today ?? "";
  const soon = today ? addDays(today, ATTENTION_DAYS) : "";
  const bills = (input.bills?.occurrences ?? [])
    .filter(open)
    .map((occurrence) => ({ occurrence, date: occurrenceDate(occurrence) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const billRow = (entry: (typeof bills)[number], pastDue: boolean): AttentionRow => ({
    kind: "bill",
    key: `bill:${entry.occurrence.planId}:${entry.occurrence.dueDate}`,
    occurrence: entry.occurrence,
    pastDue,
    match: fittingPost(input.bills!, entry.occurrence)
  });
  rows.push(...bills.filter((b) => b.date < today).map((b) => billRow(b, true)));
  rows.push(
    ...input.lines
      .filter((line) => line.available < 0)
      .sort((a, b) => a.available - b.available)
      .map((line): AttentionRow => {
        const deficit = -line.available;
        const source = coverSource(input.lines, line, deficit);
        return {
          kind: "overspent",
          key: `over:${line.id}`,
          line,
          deficitCents: deficit,
          source,
          partial: source !== null && source.availableCents < deficit
        };
      })
  );
  rows.push(
    ...bills.filter((b) => b.date >= today && b.date <= soon).map((b) => billRow(b, false))
  );
  if (input.predicted && input.predicted.total > 0)
    rows.push({
      kind: "predicted",
      key: "predicted",
      count: input.predicted.total,
      names: input.predicted.rows.slice(0, 3).map((row) => row.name),
      first: input.predicted.rows[0] ?? null,
      confirmable:
        input.predicted.rows.length === input.predicted.total &&
        input.predicted.rows.length > 0 &&
        input.predicted.rows.every((row) => row.categoryName)
          ? input.predicted.rows
          : null
    });
  return rows;
}
