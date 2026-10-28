/** Stable item identity. The actor and executable destination are supplied by owning services. */
export interface RecordingNoteSource {
  readonly sourceModuleId: "meetings";
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly itemKey: string;
}

export interface ManagedNoteActorExport {
  readonly ownerUserId: string;
  readonly generation: number;
  readonly state: "active" | "deleting" | "sealed";
  readonly operationId: string | null;
}

export interface ManagedNoteSourceExport extends ManagedNoteActorExport {
  readonly sourceModuleId: string;
  readonly sourceId: string;
}

export interface ManagedNotesExportSection {
  readonly actors: readonly ManagedNoteActorExport[];
  readonly sources: readonly ManagedNoteSourceExport[];
  readonly bindings: readonly ManagedNoteBindingExport[];
  readonly contributions: readonly ManagedNoteContributionExport[];
  readonly proposals: readonly ManagedNoteProposalExport[];
  readonly operations: readonly ManagedNoteOperationExport[];
}

/** Public values identify a reviewed candidate; they cannot authorize an executable path. */
export type RecordingNoteDestinationChoice =
  | { readonly kind: "fallback" }
  | {
      readonly kind: "candidate";
      readonly candidateId: string;
      readonly candidateRevision: string;
    };

export interface RecordingNoteCandidate {
  readonly id: string;
  readonly revision: string;
  readonly displayPath: string;
  readonly kind: "directory" | "markdown";
  readonly excerpt: string | null;
  readonly binding: "unbound" | "personal" | "work";
}

export interface RecordingNoteInventory {
  readonly candidates: readonly RecordingNoteCandidate[];
  readonly status: "complete" | "overflow" | "unavailable";
  readonly limit?: "entries" | "serialized_bytes" | "path_bytes" | "depth" | "scanned_entries";
}

export interface RecordingNoteDestination {
  readonly id: string;
  readonly displayPath: string;
  readonly kind: "private" | "linked";
}

export interface RecordingNoteReceipt {
  readonly id: string;
  readonly source: RecordingNoteSource;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: "pending" | "applied" | "undone" | "conflict";
  readonly destination: RecordingNoteDestination;
  readonly text: string;
  readonly operationId: string | null;
}

export type PrepareRecordingNoteInput =
  | {
      readonly kind: "apply";
      readonly requestId: string;
      readonly source: RecordingNoteSource;
      readonly text: string;
      readonly destination: RecordingNoteDestinationChoice;
    }
  | {
      readonly kind: "change";
      readonly requestId: string;
      readonly receiptId: string;
      readonly expectedRevision: number;
      readonly text: string;
      readonly destination: RecordingNoteDestinationChoice;
    }
  | ({ readonly kind: "undo" | "restore" } & ReviseRecordingNoteInput);

/** The persisted proposal is the authority; these displayed values are never accepted back. */
export interface RecordingNoteProposal {
  readonly id: string;
  readonly kind: "apply" | "change" | "undo" | "restore";
  readonly source: RecordingNoteSource;
  readonly receiptId: string;
  readonly expectedRevision: number;
  readonly side: "personal" | "work";
  readonly destination: RecordingNoteDestination;
  readonly before: string | null;
  readonly after: string | null;
  readonly requiresBindingConsent: boolean;
  readonly bindingReview: {
    readonly before: "unlabelled";
    readonly after: "personal" | "work";
    readonly noteRevision: string;
    readonly excerpt: string;
    readonly truncated: boolean;
  } | null;
}

export interface ApplyRecordingNoteInput {
  readonly proposalId: string;
  readonly acceptBinding: boolean;
}

export interface ReviseRecordingNoteInput {
  readonly requestId: string;
  readonly receiptId: string;
  readonly expectedRevision: number;
}

export interface RecordingNoteResult {
  readonly status: "applied" | "unchanged" | "undone" | "conflict";
  readonly receipt: RecordingNoteReceipt;
}

/** Storage values are included only in the authenticated owner's account export. */
export interface ManagedNoteDestinationExport {
  readonly id: string;
  readonly kind: "private" | "linked";
  readonly root: string | null;
  readonly path: string;
}
export interface ManagedNoteLifecycleExport {
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
export interface ManagedNoteBlockExport {
  readonly id: string;
  readonly bytes: string;
}
export interface ManagedNoteOperationLegExport {
  readonly destination: ManagedNoteDestinationExport;
  readonly expectedRevision: string | null;
  readonly bindingRevision: number | null;
  readonly side: "personal" | "work";
  readonly operation: {
    readonly before: ManagedNoteBlockExport | null;
    readonly after: ManagedNoteBlockExport | null;
  };
  readonly done: boolean;
}
export interface ManagedNoteProposalStateExport {
  readonly id: string;
  readonly lifecycle: ManagedNoteLifecycleExport;
  readonly digest: string;
  readonly review: RecordingNoteProposal;
  readonly destination: ManagedNoteDestinationExport;
  readonly text: string;
  readonly block: ManagedNoteBlockExport;
  readonly legs: readonly ManagedNoteOperationLegExport[];
}
export interface ManagedNoteOperationStateExport {
  readonly id: string;
  readonly kind: "apply" | "change" | "undo" | "restore";
  readonly receiptId: string;
  readonly source: RecordingNoteSource;
  readonly lifecycle: ManagedNoteLifecycleExport;
  readonly state: "pending" | "conflict" | "applied" | "cancelled";
  readonly resultState: "applied" | "undone";
  readonly legs: readonly ManagedNoteOperationLegExport[];
}
export interface ManagedNoteBindingExport {
  readonly destinationId: string;
  readonly side: "personal" | "work";
  readonly revision: number;
}
export interface ManagedNoteContributionExport {
  readonly receiptId: string;
  readonly sourceModuleId: "meetings";
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly sourceGeneration: number;
  readonly itemKey: string;
  readonly revision: number;
  readonly side: "personal" | "work";
  readonly state: "pending" | "applied" | "undone" | "conflict";
  readonly destination: ManagedNoteDestinationExport;
  readonly text: string;
  readonly blockBytes: string;
  readonly operationId: string | null;
  readonly cleanupOperationId: string | null;
}
export interface ManagedNoteProposalExport {
  readonly proposalId: string;
  readonly sourceModuleId: "meetings";
  readonly sourceId: string;
  readonly payload: ManagedNoteProposalStateExport;
}
export interface ManagedNoteOperationExport {
  readonly operationId: string;
  readonly receiptId: string;
  readonly sourceModuleId: "meetings";
  readonly sourceId: string;
  readonly state: ManagedNoteOperationStateExport["state"];
  readonly destinationIds: readonly string[];
  readonly payload: ManagedNoteOperationStateExport;
}
