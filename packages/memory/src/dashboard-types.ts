import type { MemoryCandidateStatus } from "./candidates-repository.js";
import type {
  MemoryConfidenceTier,
  MemoryEpisodeKind,
  MemoryEntityKind,
  MemoryEntityStatus,
  MemoryFactStatus,
  MemoryFactProvenance,
  MemoryRecordKind
} from "./graph-types.js";

export type MemoryDashboardItemKind = "candidate" | "fact" | "entity";

export type MemoryEditableField =
  | "summary"
  | "recordKind"
  | "entityName"
  | "entitySummary"
  | "validFrom"
  | "validTo"
  | "staleAt"
  | "pinned";

export interface MemoryDashboardItem {
  readonly itemKind: MemoryDashboardItemKind;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly recordKind?: MemoryRecordKind;
  readonly entityKind?: MemoryEntityKind;
  readonly status: MemoryFactStatus | MemoryCandidateStatus | MemoryEntityStatus;
  readonly confidence?: number;
  readonly confidenceTier?: MemoryConfidenceTier;
  readonly provenance?: MemoryFactProvenance | "volunteered" | "inferred";
  readonly sourceSummary: string;
  readonly sourceKind: MemoryEpisodeKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly staleAt?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly conflictGroupId?: string | null;
  readonly supersededByFactId?: string | null;
  readonly pinned?: boolean;
  readonly editableFields: readonly MemoryEditableField[];
}

export type MemoryDashboardStatusFilter =
  | "pending"
  | "promoted"
  | "merged"
  | "active"
  | "archived"
  | "stale"
  | "expired"
  | "superseded"
  | "rejected"
  | "suppressed"
  | "conflicting"
  | "history"
  | "inactive"
  | "all";

export interface MemoryDashboardQuery {
  readonly status?: MemoryDashboardStatusFilter;
  readonly recordKind?: MemoryRecordKind;
  readonly sourceKind?: MemoryEpisodeKind;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MemoryDashboardResponse {
  readonly counts: Record<string, number>;
  readonly items: readonly MemoryDashboardItem[];
  readonly nextCursor?: string;
}

export interface AcceptMemoryCandidateRequest {
  readonly edited?: {
    readonly summary?: string;
    readonly recordKind?: MemoryRecordKind;
    readonly validFrom?: string | null;
    readonly validTo?: string | null;
    readonly staleAt?: string | null;
    readonly pinned?: boolean;
    readonly entityName?: string;
    readonly entitySummary?: string | null;
  };
}

export interface RejectMemoryCandidateRequest {
  readonly reason?: string;
}

export interface SuppressMemoryCandidateRequest {
  readonly reason?: string;
}

export interface PatchMemoryFactDashboardRequest {
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly staleAt?: string | null;
  readonly pinned?: boolean;
}

export interface PatchMemoryEntityDashboardRequest {
  readonly name?: string;
  readonly summary?: string | null;
  readonly status?: "active" | "archived";
}
