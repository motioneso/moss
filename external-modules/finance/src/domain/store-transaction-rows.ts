import type { ReviewState, TransactionRecord } from "./records.js";
import { safeCents } from "./values.js";

export const TXN_COLUMNS =
  "id, account_id, date::text AS date, amount_cents, iso_currency, name, merchant, " +
  "plaid_category, category_id, pending, pending_transaction_id, categorized_by, notes, review_state, ai_confidence, splits, split_revision, source, cleared, reconciled_at";

export type TransactionRow = {
  id: string;
  account_id: string;
  date: string;
  amount_cents: string | number;
  iso_currency: string;
  name: string;
  merchant: string | null;
  plaid_category: string | null;
  category_id: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  categorized_by: TransactionRecord["categorizedBy"];
  notes: string | null;
  review_state: ReviewState;
  ai_confidence: number | null;
  splits?: TransactionRecord["splits"];
  split_revision?: number;
  source?: string;
  cleared?: boolean;
  reconciled_at?: string | null;
};

export function rowToTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.date,
    amountCents: safeCents(row.amount_cents),
    isoCurrency: row.iso_currency,
    name: row.name,
    merchant: row.merchant,
    plaidCategory: row.plaid_category,
    categoryId: row.category_id,
    pending: row.pending,
    pendingTransactionId: row.pending_transaction_id,
    categorizedBy: row.categorized_by,
    notes: row.notes ?? undefined,
    reviewState: row.review_state,
    aiConfidence: row.ai_confidence,
    ...(row.source === "manual"
      ? {
          source: "manual" as const,
          cleared: row.cleared ?? false,
          reconciledAt: row.reconciled_at ?? null
        }
      : {}),
    ...(row.splits?.length || row.split_revision
      ? { splits: row.splits ?? [], splitRevision: row.split_revision ?? 0 }
      : {})
  };
}
