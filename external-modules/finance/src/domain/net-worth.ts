// external-modules/finance/src/domain/net-worth.ts
//
// FIN-05 (#1150): daily net-worth series from the actor's OWN snapshot
// chunks (spec delta §"Net worth"). Snapshots are never mirrored, so this is
// own-accounts-only by design. Pure over its inputs; the handler loads ALL
// snapshot chunks (pre-window months feed carry-forward) and the window.
import { balanceSign } from "./account-sign.js";
import type { AccountRecord, SnapshotChunk } from "./records.js";

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
  window: string[]
): NetWorthSeries {
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

  const points: NetWorthPoint[] = [...days].sort().map((day) => {
    let totalCents = 0;
    for (const [accountId, list] of perAccount) {
      // Last known balance on or before `day`; accounts with no snapshot yet
      // contribute nothing (no back-fill — inventing history lies on charts).
      let last: number | undefined;
      for (const [date, balanceCents] of list) {
        if (date > day) break;
        last = balanceCents;
      }
      if (last !== undefined) totalCents += last * (sign.get(accountId) ?? 1);
    }
    return { date: day, totalCents };
  });

  return {
    points,
    headlineCents: points.length > 0 ? points[points.length - 1]!.totalCents : null
  };
}
