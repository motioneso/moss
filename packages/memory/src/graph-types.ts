export const memoryEntityKinds = [
  "person",
  "project",
  "preference",
  "goal",
  "constraint",
  "decision",
  "topic",
  "place",
  "organization",
  "self"
] as const;

export type MemoryEntityKind = (typeof memoryEntityKinds)[number];
export type MemoryEntityStatus = "active" | "archived" | "merged";
export type MemoryFactPredicate =
  | "prefers"
  | "works_on"
  | "has_goal"
  | "has_constraint"
  | "decided"
  | "related_to"
  | "owes"
  | "waiting_on"
  | "mentioned_in"
  | "alias_of";
export type MemoryFactProvenance = "volunteered" | "inferred" | "confirmed" | "imported";
export type MemoryRecordKind =
  | "fact"
  | "preference"
  | "goal"
  | "constraint"
  | "decision"
  | "relationship"
  | "alias"
  | "inference";
export type MemoryFactStatus =
  | "active"
  | "stale"
  | "expired"
  | "superseded"
  | "rejected"
  | "conflicting";
export type MemoryConfidenceTier = "confirmed" | "high" | "medium" | "low";
export type MemoryEpisodeKind = "chat" | "note" | "task" | "email" | "calendar" | "manual";
export type MemorySearchTargetKind = "entity" | "fact" | "episode";

export interface MemoryEntityRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly kind: MemoryEntityKind;
  readonly name: string;
  readonly summary: string;
  readonly status: MemoryEntityStatus;
  readonly importance: number;
  readonly pinned: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MemorySourceInput {
  readonly sourceKind: MemoryEpisodeKind;
  readonly sourceRef: string;
  readonly sourceLabel?: string;
  readonly occurredAt?: Date | null;
  readonly excerpt: string;
}

export interface MemorySourceSummary {
  readonly id: string;
  readonly sourceKind: MemoryEpisodeKind;
  readonly sourceRef: string;
  readonly sourceLabel: string;
  readonly excerpt: string;
  readonly occurredAt: Date | null;
}

export interface MemoryFactRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly subjectEntityId: string;
  readonly predicate: MemoryFactPredicate;
  readonly objectEntityId: string | null;
  readonly objectText: string | null;
  readonly recordKind: MemoryRecordKind;
  readonly confidence: number;
  readonly confidenceTier: MemoryConfidenceTier;
  readonly provenance: MemoryFactProvenance;
  readonly status: MemoryFactStatus;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  readonly staleAt: Date | null;
  readonly supersededByFactId: string | null;
  readonly conflictGroupId: string | null;
  readonly lastConfirmedAt: Date | null;
  readonly importance: number;
  readonly pinned: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sources: readonly MemorySourceSummary[];
}

export interface NewMemoryEntity {
  readonly kind: MemoryEntityKind;
  readonly name: string;
  readonly summary?: string;
  readonly importance?: number;
  readonly pinned?: boolean;
}

export interface NewMemoryFact {
  readonly subjectEntityId: string;
  readonly predicate: MemoryFactPredicate;
  readonly objectEntityId?: string | null;
  readonly objectText?: string | null;
  readonly recordKind?: MemoryRecordKind;
  readonly confidence?: number;
  readonly provenance?: MemoryFactProvenance;
  readonly importance?: number;
  readonly pinned?: boolean;
  readonly source: MemorySourceInput;
}

export interface MemoryRememberInput {
  readonly subjectEntityId?: string;
  readonly predicate: MemoryFactPredicate;
  readonly objectEntityId?: string | null;
  readonly objectText?: string | null;
  readonly recordKind?: MemoryRecordKind;
  readonly confidence?: number;
  readonly provenance?: MemoryFactProvenance;
  readonly importance?: number;
  readonly pinned?: boolean;
  readonly source: MemorySourceInput;
}

export interface MemoryWriteResult {
  readonly fact: MemoryFactRecord;
}

export interface MemorySupersedeInput {
  readonly factId: string;
  readonly validTo?: Date | null;
}

export interface MemoryCorrectionInput {
  readonly targetFactId: string;
  readonly replacementText: string;
  readonly correctionReason?: string;
}

export interface MemoryStatusPatchInput {
  readonly status: "active" | "stale" | "expired" | "rejected";
  readonly reason?: string;
}

export interface MemoryForgetResult {
  readonly deleted: boolean;
}

export interface MemoryRecallResult {
  readonly query: string;
  readonly items: readonly MemoryRecallItem[];
}

export interface MemoryRecallItem {
  readonly kind: "entity" | "fact" | "episode";
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
  /** Name of the person or thing a fact is about; absent for facts about the owner. */
  readonly subjectName?: string;
  readonly recordKind?: MemoryRecordKind;
  readonly status?: MemoryFactStatus;
  readonly confidence: number;
  readonly confidenceTier: MemoryConfidenceTier;
  readonly provenance: MemoryFactProvenance;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
  readonly staleAt: Date | null;
  readonly supersededByFactId?: string | null;
  readonly conflictGroupId?: string | null;
  readonly sources: readonly MemorySourceSummary[];
}

export interface MemoryRecallOptions {
  readonly limit?: number;
  readonly includeStale?: boolean;
  readonly includeInactive?: boolean;
  readonly includeLowConfidence?: boolean;
}

export interface MemoryAliasRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly entityId: string;
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly ambiguous: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MemorySearchDocumentRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly targetKind: MemorySearchTargetKind;
  readonly targetId: string;
  readonly searchText: string;
  readonly embedModelName: string | null;
  readonly embedModelVersion: string | null;
  readonly status: "active" | "inactive";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MemoryFactRecallCandidate {
  readonly fact: MemoryFactRecord;
  readonly searchText: string;
  readonly vectorSimilarity: number;
}
