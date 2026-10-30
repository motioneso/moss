import { csvText } from "./csv-text.js";
import { centsToAmountInput } from "./money-format.js";
import { safeCents } from "./values.js";
export const MAX_HISTORY_ROWS = 5000;
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
export interface HistoryScope {
  from?: string;
  through?: string;
  accountId?: string;
}
export interface HistoryRow {
  id: string;
  transferId?: string;
  accountId: string;
  accountName: string;
  date: string;
  name: string;
  amountCents: number;
  isoCurrency: string;
  categoryId: string | null;
  categoryName: string;
  pending: boolean;
  cleared: boolean | null;
  reconciledAt: string | null;
  splits: { categoryId: string; name: string; amountCents: number }[];
}
export interface HistoryExportStore {
  read(scope: HistoryScope): Promise<{ totalCount: number; rows: HistoryRow[] }>;
}
export function ownedHistoryCsv(rows: readonly HistoryRow[]): string {
  const header =
    "Date,Payee,Account,Account ID,Category,Category ID,Outflow,Inflow,Currency,Status,Cleared,Reconciled at,Transaction ID,Allocations,Allocation status,Transfer ID";
  return (
    [
      header,
      ...rows.map((row) => {
        const cents = safeCents(row.amountCents);
        const allocated = row.splits.reduce(
          (sum, part) => sum + BigInt(safeCents(part.amountCents)),
          0n
        );
        return [
          csvText(row.date),
          csvText(row.name),
          csvText(row.accountName),
          csvText(row.accountId),
          csvText(row.splits.length ? "Split" : row.categoryName),
          csvText(row.categoryId ?? ""),
          cents >= 0 ? centsToAmountInput(cents) : "",
          cents < 0 ? centsToAmountInput(-cents) : "",
          csvText(row.isoCurrency),
          csvText(row.pending ? "Pending" : "Posted"),
          csvText(row.cleared === null ? "Not tracked" : row.cleared ? "Yes" : "No"),
          csvText(row.reconciledAt ?? ""),
          csvText(row.id),
          csvText(
            row.splits
              .map(
                (p) =>
                  `${p.name} [${p.categoryId}]: ${centsToAmountInput(p.amountCents)} ${row.isoCurrency}`
              )
              .join("; ")
          ),
          csvText(
            row.splits.length ? (allocated === BigInt(cents) ? "Balanced" : "Unbalanced") : "None"
          ),
          csvText(row.transferId ?? "")
        ].join(",");
      })
    ].join("\r\n") + "\r\n"
  );
}
