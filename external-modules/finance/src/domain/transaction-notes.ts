export interface NoteTarget {
  transactionId: string;
  accountId: string;
  month: string;
}
export interface SavedTransactionNote extends NoteTarget {
  name: string;
  date: string;
  notes: string;
  writeRevision: string;
}
export interface TransactionNoteStore {
  read(target: NoteTarget): Promise<SavedTransactionNote | null>;
  save(
    target: NoteTarget,
    writeRevision: string,
    notes: string,
    at: string
  ): Promise<"saved" | "unchanged" | "stale">;
}
/** PostgreSQL text cannot hold NUL or malformed Unicode. Never trim a private note. */
export function validPrivateNote(value: string): boolean {
  return (
    !value.includes("\0") &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    new TextEncoder().encode(value).length <= 4000
  );
}
