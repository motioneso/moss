import { isCalendarMonth } from "../domain/values.js";
import { csvText } from "../domain/csv-text.js";
import { centsToAmountInput } from "./format.js";

/** The explicit, loaded register selection exported by the user. Never fetches hidden rows. */
export interface ExportTransaction {
  id: string;
  transferId?: string;
  date: string;
  accountId: string;
  name: string;
  amountCents: number;
  isoCurrency: string;
  categoryId: string | null;
  pending?: boolean;
  shared?: boolean;
  splits?: { categoryId: string; amountCents: number }[];
}

export function transactionsCsv(
  rows: readonly ExportTransaction[],
  accountName: (row: ExportTransaction) => string,
  categoryName: (row: ExportTransaction) => string
): string {
  const header =
    "Date,Payee,Account,Category,Outflow,Inflow,Currency,Status,Scope,Transaction ID,Allocations,Transfer ID";
  return (
    [
      header,
      ...rows.map((row) =>
        [
          csvText(row.date),
          csvText(row.name),
          csvText(accountName(row)),
          csvText(row.splits?.length ? "Split" : categoryName(row)),
          row.amountCents >= 0 ? centsToAmountInput(row.amountCents) : "",
          row.amountCents < 0 ? centsToAmountInput(-row.amountCents) : "",
          csvText(row.isoCurrency),
          csvText(row.pending ? "Pending" : "Posted"),
          csvText(row.shared ? "Household (read only)" : "Own"),
          csvText(row.id),
          csvText(
            (row.splits ?? [])
              .map(
                (part) =>
                  `${categoryName({ ...row, categoryId: part.categoryId })}: ${centsToAmountInput(part.amountCents)} ${row.isoCurrency}`
              )
              .join("; ")
          ),
          csvText(row.transferId ?? "")
        ].join(",")
      )
    ].join("\r\n") + "\r\n"
  );
}

export function downloadTransactionsCsv(csv: string, month: string): void {
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `moss-transactions-${month}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read-only history links never authorize another owner or an unchecked calendar scope. */
export function initialRegisterScope(search: string): {
  month?: string;
  accountId?: string;
  ownOnly: boolean;
} {
  const params = new URLSearchParams(search),
    month = params.get("month"),
    accountId = params.get("accountId");
  return {
    ...(month && isCalendarMonth(month) ? { month } : {}),
    ...(accountId && accountId.length <= 256 ? { accountId } : {}),
    ownOnly: params.get("scope") === "own"
  };
}
