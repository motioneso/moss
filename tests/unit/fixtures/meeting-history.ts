import type { MeetingHistoryItem, MeetingRecord } from "@moss/shared";

/** Synthetic metadata for unit rendering only, never live-path evidence. */
export function historyItem(
  record: MeetingRecord,
  overrides: Partial<MeetingHistoryItem> = {}
): MeetingHistoryItem {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasNotes: !!record.personalNotes.trim(),
    notesRevision: record.notesRevision,
    capture: { status: "unavailable" },
    transcript: {
      status: "none",
      revision: 0,
      segmentCount: 0,
      finalSegmentCount: 0,
      provisionalSegmentCount: 0,
      span: null,
      sources: [],
      omittedSourceCount: 0
    },
    summary: { status: "none", version: null, origin: null, createdAt: null, generation: null },
    actions: { pending: 0, accepted: 0, dismissed: 0 },
    vault: { latest: null, savedVersionCount: 0 },
    ...overrides
  };
}
