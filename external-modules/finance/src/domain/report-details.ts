import type { TransactionRecord } from "./records.js";
import { allocations, splitsBalance } from "./splits.js";
import { excludeTransfers } from "./transfers.js";
import { UNCATEGORIZED_BUCKET } from "./reports.js";
import { safeCents } from "./values.js";
export interface ReportDetailScope {
  month: string;
  currency: string;
  group: "category" | "payee" | "income" | "outflow";
  key?: string;
}
export interface ReportDetailRow {
  id: string;
  ownerUserId: string;
  shared: boolean;
  accountId: string;
  date: string;
  name: string;
  amountCents: number;
  parentAmountCents: number;
  isoCurrency: string;
  pending: boolean;
  splitPortion: boolean;
  splitNeedsReview: boolean;
}
export function deriveReportDetails(
  sources: readonly { ownerUserId: string; shared: boolean; transactions: TransactionRecord[] }[],
  scope: ReportDetailScope,
  offset: number,
  limit: number
) {
  const all: ReportDetailRow[] = [];
  for (const source of sources) {
    // Exclude before month/currency filtering, with the same complete window and owner boundary
    // as the aggregate. Otherwise a transfer crossing month end can become apparent spending.
    for (const row of excludeTransfers(source.transactions)) {
      if (row.date.slice(0, 7) !== scope.month || row.isoCurrency !== scope.currency) continue;
      const parts = allocations(row).filter((part) => {
        if (scope.group === "income") return part.categoryId === "income";
        if (part.categoryId === "income") return false;
        if (scope.group === "outflow") return true;
        if (scope.group === "payee") return (row.merchant ?? row.name) === scope.key;
        return (part.categoryId ?? UNCATEGORIZED_BUCKET) === scope.key;
      });
      if (!parts.length) continue;
      const amountCents = safeCents(
        parts.reduce((sum, part) => sum + BigInt(safeCents(part.amountCents)), 0n) *
          (scope.group === "income" ? -1n : 1n)
      );
      // Response allowlist: neither own notes nor mirror extras are report-detail fields.
      all.push({
        id: row.id,
        ownerUserId: source.ownerUserId,
        shared: source.shared,
        accountId: row.accountId,
        date: row.date,
        name: row.merchant ?? row.name,
        amountCents,
        parentAmountCents: safeCents(row.amountCents),
        isoCurrency: row.isoCurrency,
        pending: row.pending,
        splitPortion: Boolean(row.splits?.length && splitsBalance(row)),
        splitNeedsReview: Boolean(row.splits?.length && !splitsBalance(row))
      });
    }
  }
  all.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.ownerUserId.localeCompare(b.ownerUserId) ||
      a.id.localeCompare(b.id)
  );
  return {
    rows: all.slice(offset, offset + limit),
    totalCount: all.length,
    totalCents: safeCents(all.reduce((sum, row) => sum + BigInt(row.amountCents), 0n)),
    offset,
    limit
  };
}
