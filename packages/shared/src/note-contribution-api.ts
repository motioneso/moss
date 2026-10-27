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
}
