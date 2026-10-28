import type {
  MemoryConfidenceTier,
  MemoryEntityKind,
  MemoryEntityRecord,
  MemoryEntityStatus,
  MemoryEpisodeKind,
  MemoryFactPredicate,
  MemoryFactProvenance,
  MemoryFactRecord,
  MemoryFactStatus,
  MemoryRecordKind,
  MemorySourceSummary
} from "./graph-types.js";

export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export interface EntityRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly kind: MemoryEntityKind;
  readonly name: string;
  readonly summary: string;
  readonly status: MemoryEntityStatus;
  readonly importance: string | number;
  readonly pinned: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface FactRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly subject_entity_id: string;
  readonly predicate: MemoryFactPredicate;
  readonly object_entity_id: string | null;
  readonly object_text: string | null;
  readonly record_kind: MemoryRecordKind;
  readonly confidence: string | number;
  readonly provenance: MemoryFactProvenance;
  readonly status: MemoryFactStatus;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly stale_at: Date | null;
  readonly superseded_by_fact_id: string | null;
  readonly conflict_group_id: string | null;
  readonly last_confirmed_at: Date | null;
  readonly importance: string | number;
  readonly pinned: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface SourceRow {
  readonly id: string;
  readonly source_kind: MemoryEpisodeKind;
  readonly source_ref: string;
  readonly source_label: string;
  readonly occurred_at: Date | null;
  readonly excerpt: string;
}

export function mapEntity(row: EntityRow): MemoryEntityRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    status: row.status,
    importance: Number(row.importance),
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapFact(row: FactRow, sources: readonly MemorySourceSummary[]): MemoryFactRecord {
  const confidence = Number(row.confidence);
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    objectEntityId: row.object_entity_id,
    objectText: row.object_text,
    recordKind: row.record_kind,
    confidence,
    confidenceTier: confidenceTier(confidence, row.provenance, row.last_confirmed_at),
    provenance: row.provenance,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    staleAt: row.stale_at,
    supersededByFactId: row.superseded_by_fact_id,
    conflictGroupId: row.conflict_group_id,
    lastConfirmedAt: row.last_confirmed_at,
    importance: Number(row.importance),
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sources
  };
}

export function confidenceTier(
  confidence: number,
  provenance: MemoryFactProvenance,
  lastConfirmedAt: Date | null
): MemoryConfidenceTier {
  if ((provenance === "confirmed" || lastConfirmedAt) && confidence >= 0.9) return "confirmed";
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

export function mapSource(row: SourceRow): MemorySourceSummary {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    sourceLabel: row.source_label,
    occurredAt: row.occurred_at,
    excerpt: row.excerpt
  };
}
