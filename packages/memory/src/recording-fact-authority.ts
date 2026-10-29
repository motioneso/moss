import type { AccessContext, DataContextDb, ManagedSourceKey } from "@moss/db";
import type { RecordingMemorySource } from "@moss/shared";

/** Structural public seam. Memory owns no Notes or Meetings data access. */
export type { RecordingMemorySourceSnapshot as RecordingFactSourceSnapshot } from "@moss/shared";
import type { RecordingMemorySourceSnapshot as RecordingFactSourceSnapshot } from "@moss/shared";

export interface RecordingFactAuthority {
  registerSource(
    access: AccessContext,
    source: ManagedSourceKey
  ): Promise<RecordingFactSourceSnapshot>;
  /** Preparatory snapshot only; final publication must use withPublicationScoped. */
  captureSourcesScoped(
    db: DataContextDb,
    sources: readonly ManagedSourceKey[]
  ): Promise<RecordingFactSourceSnapshot>;
  readCurrent(
    db: DataContextDb,
    source: RecordingMemorySource
  ): Promise<{
    readonly sourceVersion: number;
    readonly side: "personal" | "work";
  }>;
  /** Short source-exclusive reservation before provider work; serializes per-output item bounds. */
  withReservation<T>(
    access: AccessContext,
    expected: RecordingFactSourceSnapshot,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T>;
  /** Providers run before this callback. Admission lasts through its caller transaction. */
  withPublicationScoped<T>(
    db: DataContextDb,
    expected: RecordingFactSourceSnapshot,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T>;
}
