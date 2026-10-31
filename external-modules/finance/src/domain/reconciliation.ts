export const MAX_RECONCILE_ENTRIES = 500;
export interface ReconciliationEntry {
  id: string;
  date: string;
  name: string;
  amountCents: number;
  cleared: boolean;
}
export interface ReconciliationView {
  accountId: string;
  name: string;
  isoCurrency: string;
  debt: boolean;
  openingDate: string;
  lastReconciledDate: string | null;
  revision: number;
  baselineCents: number;
  recordedCents: number;
  totalEntries: number;
  entries: ReconciliationEntry[];
}
export interface ReconciliationFinish {
  id: string;
  accountId: string;
  statementDate: string;
  balanceCents: number;
  isoCurrency: string;
  expectedRevision: number;
  selectedIds: string[];
  digest: string;
  at: string;
}
export interface ReconciliationStore {
  read(accountId: string, statementDate: string): Promise<ReconciliationView | null>;
  finish(input: ReconciliationFinish): Promise<"created" | "unchanged" | "conflict">;
}
/** Exact local preview; the database independently repeats this calculation at commit. */
export function reconciledSelectionBalance(
  view: Pick<ReconciliationView, "baselineCents" | "debt" | "entries">,
  selected: ReadonlySet<string>
): number | null {
  const total =
    BigInt(view.baselineCents) +
    (view.debt ? 1n : -1n) *
      view.entries.reduce(
        (sum, row) => sum + (selected.has(row.id) ? BigInt(row.amountCents) : 0n),
        0n
      );
  return total >= -9007199254740991n && total <= 9007199254740991n ? Number(total) : null;
}
