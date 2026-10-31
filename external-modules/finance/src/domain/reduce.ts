// external-modules/finance/src/domain/reduce.ts
//
// FIN-01 (#1146) Task 6: the PURE sync reducer over month chunks. The sync
// handler delivers /transactions/sync pages at-least-once (the cursor is
// persisted only AFTER a page's chunks are written), so every rule here is
// idempotent by transaction_id: re-applying a page to its own output is a
// byte-stable no-op. The reducer never does I/O — the caller loads exactly
// touched months and any exact-ID durable pending handoffs needed by that page.
import { monthKey } from "./keys.js";
import type { TransactionChunk, TransactionRecord } from "./records.js";
import { decimalToCents } from "./values.js";
import { splitsBalance } from "./splits.js";

// Raw Plaid /transactions/sync entry (snake_case, float dollars). Declared
// structurally instead of importing from adapters/ so the domain layer keeps
// zero upward dependencies; adapters' PlaidTx is assignable to this shape.
export type PlaidTx = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  iso_currency_code: string | null;
  name: string;
  merchant_name: string | null;
  personal_finance_category: { primary: string } | null;
  pending: boolean;
  pending_transaction_id: string | null;
};

export type SyncPage = {
  added: PlaidTx[];
  modified: PlaidTx[];
  removed: { transaction_id: string }[];
};

/** Only the months a page touches, caller-loaded. Key = monthKey(). */
export type ChunkMap = Record<string, TransactionChunk>;

/**
 * The ONE dollars→cents conversion in the module (spec "Money"). Plaid's
 * sign convention (spending-positive) is preserved with decimal rounding.
 */
export function toRecord(tx: PlaidTx): TransactionRecord {
  return {
    id: tx.transaction_id,
    accountId: tx.account_id,
    date: tx.date,
    amountCents: decimalToCents(tx.amount),
    isoCurrency: tx.iso_currency_code ?? "USD",
    name: tx.name,
    merchant: tx.merchant_name,
    plaidCategory: tx.personal_finance_category?.primary ?? null,
    categoryId: null,
    pending: tx.pending,
    pendingTransactionId: tx.pending_transaction_id,
    categorizedBy: null
  };
}

/**
 * User categorization is the only state a re-sent/replacing record must
 * carry forward — rule/plaid-map/ai assignments are re-derivable by the
 * FIN-02 pipeline, but clobbering the user's own work is data loss.
 */
function carryUserFields(from: TransactionRecord, onto: TransactionRecord): void {
  if (from.categorizedBy !== "user") return;
  onto.categoryId = from.categoryId;
  onto.categorizedBy = "user";
  if (from.reviewState !== undefined) onto.reviewState = from.reviewState;
  if (from.notes !== undefined) onto.notes = from.notes;
  if (from.amountCents !== onto.amountCents || from.isoCurrency !== onto.isoCurrency)
    onto.reviewState = "needs_look";
  if (from.splits !== undefined) {
    onto.splits = from.splits.map((split) => ({ ...split }));
    onto.splitRevision = from.splitRevision;
    if (onto.splits.length && (!splitsBalance(onto) || from.isoCurrency !== onto.isoCurrency))
      onto.reviewState = "needs_look";
  }
}

/** Sort contract from records.ts: date desc, then id asc. */
function sortChunk(records: TransactionRecord[]): void {
  records.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function reduceSyncPage(
  chunks: ChunkMap,
  page: SyncPage
): { chunks: ChunkMap; touched: string[] } {
  // Deep working copy: the reducer is pure, callers may retry with the
  // original map after a failed write.
  const next: ChunkMap = {};
  for (const [key, chunk] of Object.entries(chunks)) {
    next[key] = { transactions: chunk.transactions.map((record) => ({ ...record })) };
  }

  // transaction_id -> chunk key, built from the loaded chunks (there is NO
  // stored index — the loaded window IS the search space, plan Task 6).
  const location = new Map<string, string>();
  for (const [key, chunk] of Object.entries(next)) {
    for (const record of chunk.transactions) location.set(record.id, key);
  }

  const dropFrom = (key: string, id: string): TransactionRecord | null => {
    const chunk = next[key];
    if (!chunk) return null;
    const at = chunk.transactions.findIndex((record) => record.id === id);
    if (at < 0) return null;
    const [dropped] = chunk.transactions.splice(at, 1);
    location.delete(id);
    return dropped ?? null;
  };

  // added and modified share one upsert rule (spec: idempotent by id).
  for (const tx of [...page.added, ...page.modified]) {
    const record = toRecord(tx);
    const target = monthKey(record.accountId, record.date);

    // Same-id upsert / month-move: pull the previous version wherever it
    // lives, keeping the user's categorization on the replacement.
    const previousKey = location.get(record.id);
    const previous = previousKey === undefined ? null : dropFrom(previousKey, record.id);
    if (previous) carryUserFields(previous, record);

    // Explicit provider linkage can also identify an older durable handoff.
    // Never treat a posted/manual/different-account record as a pending twin.
    if (!record.pending && record.pendingTransactionId !== null) {
      const key = location.get(record.pendingTransactionId);
      const source =
        key === undefined
          ? undefined
          : next[key]?.transactions.find((row) => row.id === record.pendingTransactionId);
      if (
        key !== undefined &&
        source?.pending &&
        source.source !== "manual" &&
        source.accountId === record.accountId
      ) {
        const twin = dropFrom(key, record.pendingTransactionId);
        if (twin && previous?.categorizedBy !== "user") carryUserFields(twin, record);
      }
    }

    const chunk = (next[target] ??= { transactions: [] });
    chunk.transactions.push(record);
    sortChunk(chunk.transactions);
    location.set(record.id, target);
  }

  // Removed ids are dropped wherever they appear in the loaded window; ids
  // outside it are silently ignored (plan: "dropped from any loaded chunk").
  for (const { transaction_id } of page.removed) {
    const key = location.get(transaction_id);
    if (key !== undefined) dropFrom(key, transaction_id);
  }

  // touched = chunks that actually changed (or are new): the caller writes
  // exactly these back, so a replayed page produces zero KV writes.
  const touched = Object.keys(next).filter((key) => {
    const before = chunks[key];
    return before === undefined || JSON.stringify(before) !== JSON.stringify(next[key]);
  });

  return { chunks: next, touched };
}
