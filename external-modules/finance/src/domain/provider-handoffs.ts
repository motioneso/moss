import { monthKey } from "./keys.js";
import type { ChunkMap, SyncPage } from "./reduce.js";
import type { TransactionRecord } from "./records.js";
export interface ProviderHandoffStore {
  capture(
    itemId: string,
    removedIds: string[],
    posted: { id: string; accountId: string }[],
    at: string
  ): Promise<void>;
  load(itemId: string, ids: string[]): Promise<TransactionRecord[]>;
  clear(itemId: string): Promise<void>;
}
export function handoffRequest(page: SyncPage) {
  const incoming = [...page.added, ...page.modified];
  const posted = incoming
    .filter((row) => !row.pending && row.pending_transaction_id)
    .map((row) => ({ id: row.pending_transaction_id!, accountId: row.account_id }));
  const removedIds = page.removed.map((row) => row.transaction_id);
  return {
    removedIds,
    posted,
    ids: [
      ...new Set([
        ...removedIds,
        ...incoming.map((row) => row.transaction_id),
        ...posted.map((row) => row.id)
      ])
    ]
  };
}
/** Add only sources that this page will consume; these are never public register rows. */
export function hydrateHandoffs(
  chunks: ChunkMap,
  page: SyncPage,
  snapshots: TransactionRecord[]
): ChunkMap {
  const active = new Set(
    Object.values(chunks).flatMap((chunk) => chunk.transactions.map((row) => row.id))
  );
  const removed = new Set(page.removed.map((row) => row.transaction_id));
  const incoming = [...page.added, ...page.modified];
  const next = { ...chunks };
  for (const row of snapshots) {
    if (active.has(row.id) || !row.pending || row.source === "manual") continue;
    const matching =
      removed.has(row.id) ||
      incoming.some(
        (tx) =>
          tx.account_id === row.accountId &&
          (tx.transaction_id === row.id || (!tx.pending && tx.pending_transaction_id === row.id))
      );
    if (!matching) continue;
    const key = monthKey(row.accountId, row.date);
    next[key] = { transactions: [...(next[key]?.transactions ?? []), row] };
    active.add(row.id);
  }
  return next;
}
