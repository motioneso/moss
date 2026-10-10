import { requestJson } from "./client.js";

export interface MemorySettings {
  readonly recallEnabled: boolean;
  readonly factsEnabled: boolean;
}

export interface MemoryFact {
  readonly id: string;
  readonly category: string;
  readonly content: string;
  readonly importance: number;
  readonly provenance: "volunteered" | "inferred" | "confirmed";
  readonly sourceThreadId: string | null;
  readonly createdAt: string;
}

export async function getMemorySettings(): Promise<MemorySettings> {
  return requestJson<MemorySettings>("/api/chat/memory/settings");
}

export async function patchMemorySettings(patch: Partial<MemorySettings>): Promise<MemorySettings> {
  return requestJson<MemorySettings>("/api/chat/memory/settings", { method: "PATCH", body: patch });
}

export type MemoryDashboardItemKind = "candidate" | "fact" | "entity";

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
  readonly recordKind?: string;
  readonly sourceKind?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MemoryDashboardItem {
  readonly itemKind: MemoryDashboardItemKind;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly recordKind?: string;
  readonly entityKind?: string;
  readonly status: string;
  readonly confidence?: number;
  readonly confidenceTier?: string;
  readonly provenance?: string;
  readonly sourceSummary: string;
  readonly sourceKind: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly staleAt?: string | null;
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly conflictGroupId?: string | null;
  readonly supersededByFactId?: string | null;
  readonly pinned?: boolean;
  readonly editableFields: readonly string[];
}

export interface MemoryDashboardResponse {
  readonly counts: Record<string, number>;
  readonly items: readonly MemoryDashboardItem[];
  readonly nextCursor?: string;
}

export interface AcceptMemoryCandidateBody {
  readonly edited?: {
    readonly summary?: string;
    readonly recordKind?: string;
    readonly validFrom?: string | null;
    readonly validTo?: string | null;
    readonly staleAt?: string | null;
    readonly pinned?: boolean;
    readonly entityName?: string;
    readonly entitySummary?: string | null;
  };
}

export interface PatchMemoryFactBody {
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly staleAt?: string | null;
  readonly pinned?: boolean;
}

export interface PatchMemoryEntityBody {
  readonly name?: string;
  readonly summary?: string | null;
  readonly status?: "active" | "archived";
}

export async function getMemoryDashboard(
  query: MemoryDashboardQuery = {}
): Promise<MemoryDashboardResponse> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set("status", query.status);
  if (query.recordKind !== undefined) params.set("recordKind", query.recordKind);
  if (query.sourceKind !== undefined) params.set("sourceKind", query.sourceKind);
  if (query.q !== undefined) params.set("q", query.q);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  const qs = params.toString();
  return requestJson<MemoryDashboardResponse>(`/api/memory/dashboard${qs ? `?${qs}` : ""}`);
}

export async function acceptMemoryCandidate(
  id: string,
  body: AcceptMemoryCandidateBody = {}
): Promise<void> {
  await requestJson<unknown>(`/api/memory/candidates/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    body
  });
}

export async function rejectMemoryCandidate(
  id: string,
  body: { readonly reason?: string } = {}
): Promise<void> {
  await requestJson<unknown>(`/api/memory/candidates/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body
  });
}

export async function suppressMemoryCandidate(
  id: string,
  body: { readonly reason?: string } = {}
): Promise<void> {
  await requestJson<unknown>(`/api/memory/candidates/${encodeURIComponent(id)}/suppress`, {
    method: "POST",
    body
  });
}

export async function patchMemoryFact(id: string, body: PatchMemoryFactBody): Promise<void> {
  await requestJson<unknown>(`/api/memory/graph/facts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body
  });
}

export async function patchMemoryEntity(id: string, body: PatchMemoryEntityBody): Promise<void> {
  await requestJson<unknown>(`/api/memory/graph/entities/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body
  });
}

export async function deleteMemoryEntity(id: string): Promise<void> {
  await requestJson<unknown>(`/api/memory/graph/entities/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function deleteMemoryFact(id: string): Promise<void> {
  await requestJson<unknown>(`/api/memory/graph/facts/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
