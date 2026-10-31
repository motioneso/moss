import type { TransactionRecord } from "./records.js";
export interface TransactionMetadataPatch {
  id: string;
  writeRevision: string;
  categoryId: string;
  /** Absent preserves the saved note; an explicit empty string clears it. */
  notes?: string;
}
export interface TransactionMetadataStore {
  undo(activityId: string, writeRevision: string, at: string): Promise<boolean>;
  rows(
    accountId: string,
    month: string
  ): Promise<(TransactionRecord & { writeRevision: string })[]>;
  apply(
    rows: readonly TransactionMetadataPatch[],
    actor: "user" | "moss",
    at: string
  ): Promise<boolean>;
}
