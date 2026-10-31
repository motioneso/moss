// external-modules/finance/src/domain/transfers.ts
//
// FIN-05 (#1150): the transfer auto-pairing heuristic (spec delta §"Transfer
// auto-pairing"). Pure over the given rows — no clock, no I/O. Callers
// partition by owner BEFORE calling (pairing never crosses owners) and pass
// the FULL loaded set, not per-month slices (real pairs straddle month
// boundaries).
import type { TransactionRecord } from "./records.js";

export type TransferPair = { aId: string; bId: string };

const DAY_MS = 86_400_000;

// Both operands are module-controlled YYYY-MM-DD strings; parsing them at a
// fixed UTC midnight is deterministic (no ambient clock involved).
function dateDiffDays(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

/**
 * Deterministic greedy matching: sort date asc then id asc; each unmatched
 * row takes its nearest-date eligible partner (ties by id). Because the scan
 * runs in sorted order, the FIRST eligible later row IS the nearest-date /
 * lowest-id candidate, and anything more than 3 days out ends the scan.
 * Eligibility: opposite nonzero amounts, different accounts, and at least
 * one side already categorized "transfers" (keeps two unrelated $40 rows
 * from pairing while still catching the miscategorized other leg).
 */
export function pairTransfers(transactions: TransactionRecord[]): TransferPair[] {
  const sorted = [...transactions].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const matched = new Set<string>();
  const pairs: TransferPair[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    // A durable link is authoritative; never borrow an unrelated row as its other leg.
    if (a.transferId || matched.has(a.id) || a.amountCents === 0 || a.splits?.length) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      if (dateDiffDays(a.date, b.date) > 3) break;
      if (b.transferId || matched.has(b.id)) continue;
      if (b.splits?.length) continue;
      if (b.amountCents !== -a.amountCents) continue;
      if (b.accountId === a.accountId) continue;
      if (b.isoCurrency !== a.isoCurrency) continue;
      if (a.categoryId !== "transfers" && b.categoryId !== "transfers") continue;
      matched.add(a.id);
      matched.add(b.id);
      pairs.push({ aId: a.id, bId: b.id });
      break;
    }
  }
  return pairs;
}

/** Effective transfer set = paired rows ∪ rows categorized "transfers". */
export function effectiveTransferIds(transactions: TransactionRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const pair of pairTransfers(transactions)) {
    ids.add(pair.aId);
    ids.add(pair.bId);
  }
  for (const txn of transactions) {
    if (txn.transferId || txn.categoryId === "transfers") ids.add(txn.id);
  }
  return ids;
}

/** Generic so FeedRow-style extensions of TransactionRecord survive. */
export function excludeTransfers<T extends TransactionRecord>(transactions: T[]): T[] {
  const excluded = effectiveTransferIds(transactions);
  return transactions.filter((txn) => !excluded.has(txn.id));
}
