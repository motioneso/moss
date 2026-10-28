/** A stable contribution identity; owner and side come from the owning runtime. */
export interface RecordingMemorySource {
  readonly sourceModuleId: "meetings";
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly itemKey: string;
}

export interface RecordingMemoryFact {
  readonly id: string;
  readonly text: string;
  readonly revision: string;
  readonly status: "active" | "inactive";
  readonly corrected: boolean;
}

export interface RecordingMemoryReceipt {
  readonly id: string;
  readonly source: RecordingMemorySource;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: "pending" | "applied" | "undone" | "forgotten" | "conflict";
  readonly fact: RecordingMemoryFact | null;
}

export type PrepareRecordingMemoryInput =
  | {
      readonly kind: "apply";
      readonly requestId: string;
      readonly source: RecordingMemorySource;
      readonly text: string;
    }
  | {
      readonly kind: "change";
      readonly requestId: string;
      readonly receiptId: string;
      readonly expectedRevision: number;
      readonly expectedFactRevision: string | null;
      readonly text: string;
    }
  | ({
      readonly kind: "undo" | "restore" | "reconcile_side";
    } & ReviseRecordingMemoryInput);

export interface ReviseRecordingMemoryInput {
  readonly requestId: string;
  readonly receiptId: string;
  readonly expectedRevision: number;
  readonly expectedFactRevision: string | null;
}

/** Display only: application reads this persisted proposal rather than accepting these fields back. */
export interface RecordingMemoryProposal {
  readonly id: string;
  readonly kind: PrepareRecordingMemoryInput["kind"];
  readonly receiptId: string;
  readonly source: RecordingMemorySource;
  readonly expectedRevision: number;
  readonly side: "personal" | "work";
  readonly beforeSide: "personal" | "work" | null;
  readonly before: RecordingMemoryFact | null;
  readonly after: string | null;
}

export interface ApplyRecordingMemoryInput {
  readonly proposalId: string;
}

export interface RecordingMemoryResult {
  readonly status: "applied" | "unchanged" | "undone" | "forgotten" | "conflict";
  readonly receipt: RecordingMemoryReceipt;
}

/** Metadata captured for final publication; capture alone grants no mutation authority. */
export interface RecordingMemorySourceSnapshot {
  readonly ownerUserId: string;
  readonly actorGeneration: number;
  readonly sources: readonly {
    readonly source: {
      readonly ownerUserId: string;
      readonly sourceModuleId: string;
      readonly sourceId: string;
    };
    readonly generation: number;
  }[];
}

export interface RecordingMemoryVersionExport {
  readonly ownerUserId: string;
  readonly factId: string;
  readonly lineageId: string;
  readonly revision: string;
  readonly side: "personal" | "work";
  readonly state: "current" | "superseded" | "forgotten";
  readonly corrected: boolean;
  readonly replacementFactId: string | null;
}
export interface RecordingMemoryReceiptExport {
  readonly ownerUserId: string;
  readonly receiptId: string;
  readonly sourceModuleId: "meetings";
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly itemKey: string;
  readonly sourceGeneration: number;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: "pending" | "applied" | "undone" | "forgotten";
  readonly factId: string | null;
  readonly episodeId: string;
  readonly cleanupOperationId: string | null;
}
export interface RecordingMemoryProposalExport {
  readonly ownerUserId: string;
  readonly proposalId: string;
  readonly requestId: string;
  readonly receiptId: string;
  readonly kind: PrepareRecordingMemoryInput["kind"];
  readonly expectedReceiptRevision: number;
  readonly expectedFactId: string | null;
  readonly expectedFactRevision: string | null;
  readonly actorGeneration: number;
  readonly sourceGeneration: number;
  readonly side: "personal" | "work";
  readonly proposedText: string | null;
  readonly state: "prepared" | "applied";
  readonly publicationSnapshot: RecordingMemorySourceSnapshot;
  readonly before: RecordingMemoryReceipt;
  readonly createdAt: string;
}
export interface RecordingMemoryExportSection {
  readonly factVersions: readonly RecordingMemoryVersionExport[];
  readonly receipts: readonly RecordingMemoryReceiptExport[];
  readonly proposals: readonly RecordingMemoryProposalExport[];
}
