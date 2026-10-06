import type { MemoryCandidateRecord } from "./candidates-repository.js";
import type { MemoryRecordKind } from "./graph-types.js";

type CandidatePayload = Record<string, unknown> | null;

/** A manual "remember this" request stores the remembered text as its excerpt. */
function manualExcerpt(payload: CandidatePayload): string | null {
  if (payload?.manualRequest !== true || typeof payload.excerpt !== "string") return null;
  return payload.excerpt.trim() || null;
}

export function candidateTitle(payload: CandidatePayload): string {
  if (!payload) return "Memory candidate";
  const excerpt = manualExcerpt(payload);
  if (excerpt) return excerpt.slice(0, 120);
  const fact = (payload.fact ?? null) as Record<string, unknown> | null;
  if (fact) {
    const parts = [fact.subject, fact.predicate, fact.objectText ?? fact.objectName].filter(
      Boolean
    );
    if (parts.length > 0) return (parts as string[]).join(" ");
  }
  const entity = (payload.entity ?? null) as Record<string, unknown> | null;
  if (entity && typeof entity.name === "string") return entity.name;
  if (typeof payload.summary === "string") return payload.summary.slice(0, 120);
  return "Memory candidate";
}

export function candidateSummary(payload: CandidatePayload): string {
  if (!payload) return "";
  const excerpt = manualExcerpt(payload);
  if (excerpt) return excerpt;
  if (typeof payload.summary === "string") return payload.summary;
  const fact = (payload.fact ?? null) as Record<string, unknown> | null;
  if (fact && typeof fact.objectText === "string") return fact.objectText;
  return candidateTitle(payload);
}

/** The full, untruncated text a person approves when accepting or rejecting a candidate. */
export function candidateLabel(payload: CandidatePayload): string {
  return payload?.fact && !manualExcerpt(payload)
    ? candidateTitle(payload)
    : candidateSummary(payload);
}

export interface PendingMemoryCandidateItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly recordKind?: MemoryRecordKind;
  readonly provenance: MemoryCandidateRecord["provenance"];
  readonly createdAt: string;
}

/** The pending-list projection: display text only, never episode or source references. */
export function pendingCandidateItem(c: MemoryCandidateRecord): PendingMemoryCandidateItem {
  const payload = c.payloadJson as CandidatePayload;
  const recordKind =
    typeof payload?.recordKind === "string" ? (payload.recordKind as MemoryRecordKind) : undefined;
  return {
    id: c.id,
    title: candidateTitle(payload),
    summary: candidateSummary(payload),
    ...(recordKind ? { recordKind } : {}),
    provenance: c.provenance,
    createdAt: c.createdAt.toISOString()
  };
}
