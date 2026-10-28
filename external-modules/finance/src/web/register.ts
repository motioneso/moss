import { centsToAmountInput } from "./format.js";

/** The explicit, loaded register selection exported by the user. Never fetches hidden rows. */
export interface ExportTransaction {
  id: string;
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

function csvText(value: string): string {
  // Spreadsheet applications may evaluate a quoted cell as a formula. Prefix only text;
  // numeric amount columns are generated from validated integer cents.
  const safe = /^[\s]*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function transactionsCsv(
  rows: readonly ExportTransaction[],
  accountName: (row: ExportTransaction) => string,
  categoryName: (row: ExportTransaction) => string
): string {
  const header =
    "Date,Payee,Account,Category,Outflow,Inflow,Currency,Status,Scope,Transaction ID,Allocations";
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
          )
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
