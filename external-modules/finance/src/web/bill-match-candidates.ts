import { isCalendarDate, safeCents } from "../domain/values.js";

interface MatchCandidate {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
}
interface MatchOccurrence {
  accountId: string;
  dueDate: string;
  plannedDate?: string;
  expectedCents: number;
}
const compare = (left: string | bigint, right: typeof left) =>
  left < right ? -1 : left > right ? 1 : 0;
function calendarDay(date: string): number {
  if (!isCalendarDate(date)) throw new Error("Invalid posted bill match date");
  return Date.parse(`${date}T00:00:00Z`) / 86400000;
}

/** Presentation order only: keep every own-account candidate and never select a match. */
export function billMatchCandidates<T extends MatchCandidate>(
  transactions: readonly T[],
  occurrence: MatchOccurrence
): T[] {
  const plannedDay = calendarDay(occurrence.plannedDate ?? occurrence.dueDate);
  const expected = BigInt(safeCents(occurrence.expectedCents));
  return transactions
    .filter((row) => row.accountId === occurrence.accountId)
    .map((row) => {
      const difference = BigInt(safeCents(row.amountCents)) - expected;
      return {
        row,
        days: Math.abs(calendarDay(row.date) - plannedDay),
        difference: difference < 0n ? -difference : difference
      };
    })
    .sort(
      (left, right) =>
        left.days - right.days ||
        compare(left.difference, right.difference) ||
        compare(left.row.date, right.row.date) ||
        compare(left.row.id, right.row.id)
    )
    .map(({ row }) => row);
}
