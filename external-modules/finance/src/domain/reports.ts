// external-modules/finance/src/domain/reports.ts
//
// FIN-05 (#1150): spending/cash-flow aggregation (spec delta §"Spending &
// cash-flow aggregation"). Pure over (transactions, window) — the handler
// computes the window from ports.now() and pre-excludes transfers
// (domain/transfers.ts) before calling; nothing here touches a clock or KV.
import type { TransactionRecord } from "./records.js";
import { allocations } from "./splits.js";

/** Bucket key for categoryId===null rows. Reports INCLUDE uncategorized
 *  spending (unlike budget activity) — hiding it would make report totals
 *  disagree with the feed. No default taxonomy id collides with this. */
export const UNCATEGORIZED_BUCKET = "uncategorized";

export type MonthCashFlow = { incomeCents: number; outflowCents: number; netCents: number };

export type MonthSpending = {
  month: string;
  /** Signed spending-positive sums; refunds net against their category. */
  byCategory: Record<string, number>;
  /** Same sums grouped by merchant ?? name. */
  byPayee: Record<string, number>;
  cashFlow: MonthCashFlow;
};

/** Ascending YYYY-MM list of `months` calendar months ending at now's month.
 *  Date.UTC with explicit args is deterministic — `now` is the ports clock. */
export function monthWindow(now: Date, months: number): string[] {
  const window: string[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    window.push(shifted.toISOString().slice(0, 7));
  }
  return window;
}

/** Aggregate an ALREADY post-exclusion row set into per-month spending and
 *  cash flow. Income rows (categoryId "income") never enter the category or
 *  payee breakdowns — they drive incomeCents with the envelope sign flip. */
export function aggregateSpending(
  transactions: TransactionRecord[],
  window: string[]
): MonthSpending[] {
  const byMonth = new Map<string, TransactionRecord[]>(window.map((month) => [month, []]));
  for (const txn of transactions) {
    byMonth.get(txn.date.slice(0, 7))?.push(txn);
  }
  return window.map((month) => {
    const byCategory: Record<string, number> = {};
    const byPayee: Record<string, number> = {};
    let incomeCents = 0;
    let outflowCents = 0;
    for (const txn of (byMonth.get(month) ?? []).flatMap((row) =>
      allocations(row).map((part) => ({ ...row, ...part }))
    )) {
      if (txn.categoryId === "income") {
        incomeCents += -txn.amountCents;
        continue;
      }
      outflowCents += txn.amountCents;
      const bucket = txn.categoryId ?? UNCATEGORIZED_BUCKET;
      byCategory[bucket] = (byCategory[bucket] ?? 0) + txn.amountCents;
      const payee = txn.merchant ?? txn.name;
      byPayee[payee] = (byPayee[payee] ?? 0) + txn.amountCents;
    }
    return {
      month,
      byCategory,
      byPayee,
      cashFlow: { incomeCents, outflowCents, netCents: incomeCents - outflowCents }
    };
  });
}

/** Sum window-aligned MonthSpending arrays (own + each shared owner). Lives
 *  in the domain so the web screen can merge AFTER its fail-closed owner
 *  drop without re-implementing the arithmetic. */
export function mergeSpendingMonths(window: string[], sources: MonthSpending[][]): MonthSpending[] {
  return window.map((month, index) => {
    const byCategory: Record<string, number> = {};
    const byPayee: Record<string, number> = {};
    let incomeCents = 0;
    let outflowCents = 0;
    for (const source of sources) {
      const entry = source[index];
      if (!entry || entry.month !== month) continue;
      for (const [key, cents] of Object.entries(entry.byCategory)) {
        byCategory[key] = (byCategory[key] ?? 0) + cents;
      }
      for (const [key, cents] of Object.entries(entry.byPayee)) {
        byPayee[key] = (byPayee[key] ?? 0) + cents;
      }
      incomeCents += entry.cashFlow.incomeCents;
      outflowCents += entry.cashFlow.outflowCents;
    }
    return {
      month,
      byCategory,
      byPayee,
      cashFlow: { incomeCents, outflowCents, netCents: incomeCents - outflowCents }
    };
  });
}
