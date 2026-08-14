import type {
  AnswerProvenanceMetadataV1,
  AnswerProvenanceSourceKind,
  AnswerProvenanceState,
  AnswerSourceSupport,
  AnswerSourceSupportCard
} from "@moss/shared";
import type { MemoryRecallItem } from "@moss/memory";
import type { NotesRecallSnippet } from "@moss/notes";

import type { CrossToolEvidenceItem, CrossToolSource } from "./cross-tool-reasoning.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SUPPORT_ITEMS = 8;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SNIPPET_CHARS = 240;
const MAX_LABEL_CHARS = 120;
const MAX_TITLE_CHARS = 160;
/** Matches [[S1]] through [[S99]] — only uppercase S + 1-2 digits. */
const MARKER_RE = /\[\[S(\d{1,2})\]\]/g;

// ── Sanitize ──────────────────────────────────────────────────────────────────

export function sanitizePlainText(text: string, maxLen?: number): string {
  // Strip control characters except tab (0x09), LF (0x0A), CR (0x0D)
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return maxLen !== undefined && cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function sanitizeLabel(text: string): string {
  return sanitizePlainText(text, MAX_LABEL_CHARS);
}

function sanitizeTitle(text: string): string {
  return sanitizePlainText(text, MAX_TITLE_CHARS);
}

function sanitizeSnippet(text: string): string {
  return sanitizePlainText(text, MAX_SNIPPET_CHARS);
}

// ── Marker parsing ────────────────────────────────────────────────────────────

export function parseAnswerMarkers(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MARKER_RE)) {
    const n = parseInt(match[1]!, 10);
    if (n >= 1 && n <= 99) ids.add(`S${n}`);
  }
  return [...ids];
}

export function stripAnswerMarkers(text: string, validIds: ReadonlySet<string>): string {
  return text.replace(MARKER_RE, (match, digits) => {
    const id = `S${parseInt(digits, 10)}`;
    return validIds.has(id) ? "" : match;
  });
}

// ── Support id sequencing ─────────────────────────────────────────────────────

function supportIdForIndex(idx: number): string {
  return `S${idx + 1}`;
}

// ── Converters: CrossToolEvidenceItem → AnswerSourceSupport ──────────────────

const CROSS_TOOL_SOURCE_KIND: Record<CrossToolSource, AnswerProvenanceSourceKind> = {
  notes: "note",
  email: "email",
  calendar: "calendar",
  tasks: "task"
};

export function crossToolItemToSupport(
  item: CrossToolEvidenceItem,
  idx: number
): AnswerSourceSupport {
  const sourceKind = CROSS_TOOL_SOURCE_KIND[item.source];
  const snippet = sanitizeSnippet(item.summary);
  const title = sanitizeTitle(item.title);
  const sourceLabel = sanitizeLabel(item.sourceLabel);

  let occurredAt: string | undefined;
  if (item.occurredAt) {
    try {
      occurredAt = new Date(item.occurredAt).toISOString();
    } catch {
      /* skip */
    }
  } else if (item.startsAt) {
    try {
      occurredAt = new Date(item.startsAt).toISOString();
    } catch {
      /* skip */
    }
  } else if (item.dueAt) {
    try {
      occurredAt = new Date(item.dueAt).toISOString();
    } catch {
      /* skip */
    }
  }

  return {
    supportId: supportIdForIndex(idx),
    sourceKind,
    sourceLabel,
    title,
    snippet: snippet || undefined,
    state: "unverified_context",
    canDereference: false,
    occurredAt
  };
}

// ── Converters: MemoryRecallItem → AnswerSourceSupport ───────────────────────

function memorySourceKind(item: MemoryRecallItem): AnswerProvenanceSourceKind {
  const src = item.sources[0];
  if (!src) return "memory";
  const kind = src.sourceKind;
  if (kind === "note") return "note";
  if (kind === "email") return "email";
  if (kind === "calendar") return "calendar";
  if (kind === "task") return "task";
  return "memory";
}

function memoryState(item: MemoryRecallItem): AnswerProvenanceState {
  const p = item.provenance;
  if (p === "confirmed" || p === "volunteered") return "confirmed_source";
  return "inferred_memory";
}

export function memoryItemToSupport(item: MemoryRecallItem, idx: number): AnswerSourceSupport {
  const src = item.sources[0];
  const sourceKind = memorySourceKind(item);
  const sourceLabel = sanitizeLabel(src?.sourceLabel ?? "Memory");
  const title = sanitizeTitle(item.title || item.text.slice(0, MAX_TITLE_CHARS));
  const snippet = sanitizeSnippet(item.text);

  let occurredAt: string | undefined;
  if (src?.occurredAt) {
    try {
      occurredAt = src.occurredAt.toISOString();
    } catch {
      /* skip */
    }
  } else if (item.validFrom) {
    try {
      occurredAt = item.validFrom.toISOString();
    } catch {
      /* skip */
    }
  }

  return {
    supportId: supportIdForIndex(idx),
    sourceKind,
    sourceLabel,
    title,
    snippet: snippet || undefined,
    state: memoryState(item),
    confidence: item.confidence,
    confidenceTier: item.confidenceTier,
    provenance: item.provenance as AnswerSourceSupport["provenance"],
    occurredAt,
    canDereference: false
  };
}

export function notesItemToSupport(item: NotesRecallSnippet, idx: number): AnswerSourceSupport {
  return {
    supportId: supportIdForIndex(idx),
    sourceKind: "note",
    sourceLabel: sanitizeLabel(item.sourcePath),
    title: sanitizeTitle(item.sourcePath),
    snippet: sanitizeSnippet(item.text) || undefined,
    state: "unverified_context",
    occurredAt: item.updatedAt.toISOString(),
    canDereference: false
  };
}

// ── Finalizer ─────────────────────────────────────────────────────────────────

function estimateJsonBytes(items: readonly AnswerSourceSupport[]): number {
  return Buffer.byteLength(JSON.stringify(items), "utf8");
}

const STATE_PRIORITY: Record<AnswerProvenanceState, number> = {
  confirmed_source: 3,
  inferred_memory: 2,
  pending_candidate: 2,
  ambiguous_identity: 2,
  unverified_context: 1
};

export function finalizeProvenance(
  candidates: readonly AnswerSourceSupport[],
  citedIds: readonly string[]
): AnswerProvenanceMetadataV1 {
  const citedSet = new Set(citedIds);

  const valid = candidates.filter(
    (item) =>
      typeof item.supportId === "string" &&
      item.supportId.length > 0 &&
      typeof item.sourceKind === "string" &&
      typeof item.sourceLabel === "string" &&
      item.sourceLabel.length > 0 &&
      typeof item.title === "string" &&
      item.title.length > 0 &&
      typeof item.state === "string" &&
      typeof item.canDereference === "boolean"
  );

  const seen = new Set<string>();
  const deduped = valid.filter((item) => {
    if (seen.has(item.supportId)) return false;
    seen.add(item.supportId);
    return true;
  });

  const sorted = [...deduped].sort((a, b) => {
    const aCited = citedSet.has(a.supportId) ? 1 : 0;
    const bCited = citedSet.has(b.supportId) ? 1 : 0;
    if (bCited !== aCited) return bCited - aCited;
    const pDiff = (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0);
    if (pDiff !== 0) return pDiff;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  let capped = sorted.slice(0, MAX_SUPPORT_ITEMS);
  let omittedCount = sorted.length - capped.length;

  while (capped.length > 0 && estimateJsonBytes(capped) > MAX_PAYLOAD_BYTES) {
    capped = capped.slice(0, -1);
    omittedCount += 1;
  }

  const finalIds = new Set(capped.map((i) => i.supportId));
  const citedSupportIds = citedIds.filter((id) => finalIds.has(id));
  const contextCheckedCount = capped.filter((i) => !citedSet.has(i.supportId)).length;

  return {
    version: 1,
    citedSupportIds,
    supportItems: capped,
    contextCheckedCount,
    omittedCount
  };
}

// ── DTO conversion ────────────────────────────────────────────────────────────

export function toSupportCard(item: AnswerSourceSupport): AnswerSourceSupportCard {
  const { citationToken: _dropped, ...card } = item;
  return card;
}

// ── Read stored provenance from tool_metadata ─────────────────────────────────

export function readStoredProvenance(
  toolMetadata: Record<string, unknown>
): AnswerProvenanceMetadataV1 | null {
  const raw = toolMetadata.answerProvenanceV1;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const meta = raw as Record<string, unknown>;
  if (meta.version !== 1) return null;
  if (!Array.isArray(meta.citedSupportIds)) return null;
  if (!Array.isArray(meta.supportItems)) return null;
  if (typeof meta.contextCheckedCount !== "number") return null;
  if (typeof meta.omittedCount !== "number") return null;
  return meta as unknown as AnswerProvenanceMetadataV1;
}

export function provenanceCards(metadata: AnswerProvenanceMetadataV1): AnswerSourceSupportCard[] {
  return metadata.supportItems.map(toSupportCard);
}
