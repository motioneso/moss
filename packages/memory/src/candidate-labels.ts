import type { MemoryCandidateRecord } from "./candidates-repository.js";
import type { MemoryRecordKind } from "./graph-types.js";

type CandidatePayload = Record<string, unknown> | null;
const RECORD_KINDS = [
  "fact",
  "preference",
  "goal",
  "constraint",
  "decision",
  "relationship",
  "alias",
  "inference"
] as const satisfies readonly MemoryRecordKind[];

/** A manual "remember this" request stores the remembered text as its excerpt. */
function manualExcerpt(payload: CandidatePayload): string | null {
  if (payload?.manualRequest !== true || typeof payload.excerpt !== "string") return null;
  return payload.excerpt.trim() || null;
}

export function candidateTitle(
  payload: CandidatePayload,
  options: { readonly fullText?: boolean } = {}
): string {
  if (!payload) return "Memory candidate";
  const excerpt = manualExcerpt(payload);
  if (excerpt) return options.fullText ? excerpt : excerpt.slice(0, 120);
  const fact = (payload.fact ?? null) as Record<string, unknown> | null;
  if (fact) {
    const parts = [fact.subject, fact.predicate, fact.objectText ?? fact.objectName].filter(
      Boolean
    );
    if (parts.length > 0) return (parts as string[]).join(" ");
  }
  const entity = (payload.entity ?? null) as Record<string, unknown> | null;
  if (entity && typeof entity.name === "string") return entity.name;
  if (typeof payload.summary === "string")
    return options.fullText ? payload.summary : payload.summary.slice(0, 120);
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
  readonly titleTruncated: boolean;
  readonly summaryTruncated: boolean;
  readonly recordKind?: MemoryRecordKind;
  readonly provenance: MemoryCandidateRecord["provenance"];
  readonly createdAt: string;
}

function excerpt(text: string, maxUnits: number): { text: string; truncated: boolean } {
  let units = 0;
  for (const point of text) {
    if (units + point.length > maxUnits) break;
    units += point.length;
  }
  return { text: text.slice(0, units), truncated: units < text.length };
}

/** Bounded list excerpts only; candidateLabel and approval targets keep their full text. */
export function pendingCandidateItem(c: MemoryCandidateRecord): PendingMemoryCandidateItem {
  const payload = c.payloadJson as CandidatePayload;
  const recordKind = RECORD_KINDS.find((kind) => kind === payload?.recordKind);
  // Five rows at these UTF-16 limits fit the 16k tool budget even after JSON and HTML escaping.
  const title = excerpt(candidateTitle(payload, { fullText: true }), 120);
  const summary = excerpt(candidateSummary(payload), 200);
  return {
    id: c.id,
    title: title.text,
    summary: summary.text,
    titleTruncated: title.truncated,
    summaryTruncated: summary.truncated,
    ...(recordKind ? { recordKind } : {}),
    provenance: c.provenance,
    createdAt: c.createdAt.toISOString()
  };
}
