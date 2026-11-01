// external-modules/meals/src/store/log-port.ts
//
// What the log tools and the estimate job need from storage. The SQL store implements it and the
// handler tests use an in-memory twin.
import type {
  CaptureKind,
  EstimateState,
  LogEntryView,
  LogItemView,
  NutrientsView
} from "../contracts.js";

export interface CreateEntryInput {
  readonly entryId: string;
  readonly consumedAt: Date;
  readonly localDate: string;
  readonly timezoneOffset: number;
  readonly description: string;
  readonly servingNote: string | null;
  readonly captureKind: CaptureKind;
  readonly idempotencyKey: string;
}

export interface CreateEntryResult {
  readonly entry: LogEntryView;
  /** False when the idempotency key matched an entry that already existed. */
  readonly created: boolean;
}

export interface RecordEstimateInput {
  readonly state: Exclude<EstimateState, "pending">;
  /** The estimate row's nutrients are written as the sum of these items. */
  readonly items: readonly LogItemView[];
  readonly nutrients: NutrientsView | null;
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

/**
 * One item of a correction, merged by position over the entry's current items. An omitted field
 * keeps the stored value. An item past the end of the current list is new and needs a label.
 */
export interface CorrectItemPatch {
  readonly label?: string;
  readonly portionNote?: string | null;
  readonly nutrients?: Partial<NutrientsView>;
}

export interface CorrectEntryPatch {
  readonly description?: string;
  readonly servingNote?: string | null;
  readonly consumedAt?: Date;
  readonly localDate?: string;
  readonly timezoneOffset?: number;
  /** The entry's figures are always the sum of its items, so there is no entry-level patch. */
  readonly items?: readonly CorrectItemPatch[];
}

export interface LogStore {
  /** Idempotent on the key. A retry returns the existing entry with created false. */
  createEntry(input: CreateEntryInput): Promise<CreateEntryResult>;
  getEntry(entryId: string): Promise<LogEntryView | null>;
  /** One local date, earliest first. */
  listForLocalDate(localDate: string): Promise<LogEntryView[]>;
  /** Inclusive range, earliest first. */
  listForDateRange(fromLocalDate: string, toLocalDate: string): Promise<LogEntryView[]>;
  /** Applies an estimate if the revision still matches. Null when it moved on or was deleted. */
  recordEstimate(
    entryId: string,
    expectedRevision: number,
    outcome: RecordEstimateInput
  ): Promise<LogEntryView | null>;
  /** Applies a user correction if the revision still matches. Null on a stale revision. */
  correctEntry(
    entryId: string,
    expectedRevision: number,
    patch: CorrectEntryPatch
  ): Promise<LogEntryView | null>;
  /**
   * Puts a failed entry back to pending at the same revision, so a retry can enqueue. Null when
   * the entry is missing or not failed at that revision.
   */
  markPending(entryId: string, expectedRevision: number): Promise<LogEntryView | null>;
  deleteEntry(entryId: string): Promise<boolean>;
}
