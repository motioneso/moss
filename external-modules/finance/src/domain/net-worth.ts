// external-modules/finance/src/domain/net-worth.ts
//
// FIN-05 (#1150): daily net-worth series from the actor's OWN snapshot
// chunks (spec delta §"Net worth"). Snapshots are never mirrored, so this is
// own-accounts-only by design. Pure over its inputs; the handler loads ALL
// snapshot chunks (pre-window months feed carry-forward) and the window.
import { balanceSign } from "./account-sign.js";
import type { AccountRecord, SnapshotChunk } from "./records.js";
import { isCalendarDate, safeCents, requireSingleCurrency } from "./values.js";

export type NetWorthPoint = { date: string; totalCents: number };

export type NetWorthSeries = {
  /** Ascending by date; one point per day that has ≥1 snapshot in-window. */
  points: NetWorthPoint[];
  /** Latest series point — from snapshots, NOT live balances. Null = none. */
  headlineCents: number | null;
};

export function deriveNetWorth(
  accounts: AccountRecord[],
  chunks: Record<string, SnapshotChunk>,
  window: string[],
  referenceDays: readonly string[] = []
): NetWorthSeries {
  requireSingleCurrency(accounts.map((account) => account.isoCurrency));
  const windowSet = new Set(window);
  // Liabilities count against net worth; everything else counts toward it.
  const sign = new Map(accounts.map((acc) => [acc.accountId, balanceSign(acc.type)]));

  // Per-account date-ascending (date, balance) lists across ALL chunks, plus
  // the union of in-window days that will become series points.
  const perAccount = new Map<string, Array<[string, number]>>();
  const days = new Set<string>();
  for (const [key, chunk] of Object.entries(chunks)) {
    // monthKey is `${accountId}:${YYYY-MM}`; account ids may themselves
    // contain ":" (the #1155 class of bug), so split on the LAST colon.
    const accountId = key.slice(0, key.lastIndexOf(":"));
    if (!sign.has(accountId)) continue;
    let list = perAccount.get(accountId);
    if (!list) {
      list = [];
      perAccount.set(accountId, list);
    }
    for (const [date, balanceCents] of Object.entries(chunk.days)) {
      list.push([date, balanceCents]);
      if (windowSet.has(date.slice(0, 7))) days.add(date);
    }
  }
  for (const list of perAccount.values()) {
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  for (const day of referenceDays) {
    if (!isCalendarDate(day)) throw new Error("Invalid net worth reference day");
    if (
      windowSet.has(day.slice(0, 7)) &&
      [...perAccount.values()].some((list) => list[0] && list[0][0] <= day)
    )
      days.add(day);
  }
  const cursors = new Map<string, { index: number; last: number | undefined }>();
  const points: NetWorthPoint[] = [...days].sort().map((day) => {
    let totalCents = 0n;
    for (const [accountId, list] of perAccount) {
      // Last known balance on or before `day`; accounts with no snapshot yet
      // contribute nothing (no back-fill — inventing history lies on charts).
      const cursor = cursors.get(accountId) ?? { index: 0, last: undefined };
      while (cursor.index < list.length && list[cursor.index]![0] <= day) {
        cursor.last = safeCents(list[cursor.index]![1]);
        cursor.index++;
      }
      cursors.set(accountId, cursor);
      if (cursor.last !== undefined)
        totalCents += BigInt(cursor.last) * BigInt(sign.get(accountId) ?? 1);
    }
    return { date: day, totalCents: safeCents(totalCents) };
  });

  return {
    points,
    headlineCents: points.length > 0 ? points[points.length - 1]!.totalCents : null
  };
}
