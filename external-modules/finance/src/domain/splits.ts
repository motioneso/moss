import type { TransactionRecord, TransactionSplit } from "./records.js";

export function splitsBalance(record: Pick<TransactionRecord, "amountCents" | "splits">): boolean {
  if (!record.splits?.length) return false;
  if (!Number.isSafeInteger(record.amountCents)) return false;
  let total = 0n;
  for (const split of record.splits) {
    if (!Number.isSafeInteger(split.amountCents)) return false;
    total += BigInt(split.amountCents);
  }
  return total === BigInt(record.amountCents);
}

/** Invalidated allocations remain stored for repair, but never inflate reports. */
export function allocations(
  record: TransactionRecord
): { categoryId: string | null; amountCents: number }[] {
  if (splitsBalance(record)) return record.splits!;
  return [
    {
      categoryId: record.splits?.length ? null : record.categoryId,
      amountCents: record.amountCents
    }
  ];
}

export interface SplitChange {
  transactionId: string;
  accountId: string;
  month: string;
  expectedAmountCents: number;
  expectedCurrency: string;
  expectedRevision: number;
  splits: TransactionSplit[];
}
