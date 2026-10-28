import type { DataContextDb } from "@moss/db";
import type { RecordingNoteSource } from "@moss/shared";
import type { ManagedSourceSnapshot } from "./managed-source-lifecycle.js";
import type { RecordingNoteBlock } from "./recording-note-blocks.js";
import type { PendingRecordingNoteOperation } from "./recording-note-operation.js";
import type {
  RecordingNoteDestination,
  RecordingNoteProposal,
  RecordingNoteReceipt
} from "@moss/shared";

export interface StoredNoteDestination {
  readonly id: string;
  readonly kind: "private" | "linked";
  readonly root: string | null;
  readonly path: string;
}

export interface NoteDestinationBinding {
  readonly destinationId: string;
  readonly side: "personal" | "work";
  readonly revision: number;
}

export interface ContributionReceiptRow {
  readonly id: string;
  readonly sourceGeneration: number;
  readonly source: RecordingNoteSource;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: "pending" | "applied" | "undone" | "conflict";
  readonly destination: StoredNoteDestination;
  readonly text: string;
  readonly block: RecordingNoteBlock;
  readonly operationId: string | null;
}

export interface ContributionLeg {
  readonly destination: StoredNoteDestination;
  readonly expectedRevision: string | null;
  readonly bindingRevision: number | null;
  readonly side: "personal" | "work";
  readonly operation: PendingRecordingNoteOperation;
  readonly done: boolean;
}

export interface ContributionProposalRow {
  readonly id: string;
  readonly lifecycle: ManagedSourceSnapshot;
  readonly digest: string;
  readonly review: RecordingNoteProposal;
  readonly destination: StoredNoteDestination;
  readonly text: string;
  readonly block: RecordingNoteBlock;
  readonly legs: readonly ContributionLeg[];
}

export interface ContributionOperationRow {
  readonly id: string;
  readonly kind: "apply" | "change" | "undo" | "restore";
  readonly receiptId: string;
  readonly source: RecordingNoteSource;
  readonly lifecycle: ManagedSourceSnapshot;
  readonly state: "pending" | "conflict" | "applied";
  readonly resultState: "applied" | "undone";
  readonly legs: readonly ContributionLeg[];
}

/** The host resolves current Meetings authority without giving Notes another module's tables. */
export interface RecordingContributionAuthority {
  readCurrent(
    db: DataContextDb,
    source: RecordingNoteSource
  ): Promise<{ readonly sourceVersion: number; readonly side: "personal" | "work" }>;
}

/** Both operations are scoped; a host adapter may not open another transaction here. */
export interface RecordingContributionIndexPort {
  invalidateScoped(db: DataContextDb, destinationIds: readonly string[]): Promise<void>;
  enqueueScoped(db: DataContextDb, destinations: readonly StoredNoteDestination[]): Promise<void>;
}

export class NoteContributionUnavailableError extends Error {
  constructor() {
    super("This recording contribution or destination is unavailable");
    this.name = "NoteContributionUnavailableError";
  }
}
export class NoteContributionConflictError extends Error {
  constructor() {
    super("The reviewed note, binding or contribution changed; review its current state");
    this.name = "NoteContributionConflictError";
  }
}

export function publicNoteDestination(input: StoredNoteDestination): RecordingNoteDestination {
  return { id: input.id, kind: input.kind, displayPath: input.path };
}
export function publicNoteReceipt(row: ContributionReceiptRow): RecordingNoteReceipt {
  return {
    id: row.id,
    source: row.source,
    revision: row.revision,
    side: row.side,
    state: row.state,
    destination: publicNoteDestination(row.destination),
    text: row.text,
    operationId: row.operationId
  };
}
