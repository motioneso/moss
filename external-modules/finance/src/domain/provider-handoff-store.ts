import type { TransactionRecord } from "./records.js";
/** Browser-safe storage vocabulary, separate from sync workspace/runtime dependencies. */
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
