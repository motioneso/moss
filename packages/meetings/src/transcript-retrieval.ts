import type {
  MeetingTranscriptLedger,
  MeetingTranscriptSegment,
  MeetingTranscriptSnapshot
} from "@moss/shared";

/** Rank the complete authorized revision set before imposing the evidence budget. */
export function retrieveMeetingTranscript(
  ledger: MeetingTranscriptLedger,
  input: {
    readonly query: string;
    readonly cutoffMs: number;
    readonly maxSegments: number;
    readonly maxCharacters: number;
  }
): MeetingTranscriptSnapshot {
  if (
    !Number.isSafeInteger(input.cutoffMs) ||
    input.cutoffMs < 0 ||
    !Number.isSafeInteger(input.maxSegments) ||
    input.maxSegments < 1 ||
    input.maxSegments > 500 ||
    !Number.isSafeInteger(input.maxCharacters) ||
    input.maxCharacters < 1 ||
    input.maxCharacters > 100_000
  )
    throw new Error("Invalid meeting retrieval limits");
  const latest = new Map<string, MeetingTranscriptSegment>();
  for (const revision of ledger.revisions) latest.set(revision.segment.segmentId, revision.segment);
  const terms = new Set(
    input.query
      .slice(0, 4000)
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu)
  );
  const eligible = [...latest.values()].filter(
    (segment) => segment.endMs <= input.cutoffMs && segment.text.length > 0
  );
  const ranked = eligible
    .map((segment) => {
      const words = new Set(segment.text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu));
      return { segment, score: [...terms].filter((term) => words.has(term)).length };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.segment.finality === "final") - Number(a.segment.finality === "final") ||
        a.segment.startMs - b.segment.startMs ||
        a.segment.segmentId.localeCompare(b.segment.segmentId, "en")
    );
  const segments: MeetingTranscriptSegment[] = [];
  let characters = 0;
  for (const { segment } of ranked) {
    if (segments.length >= input.maxSegments) break;
    if (characters + segment.text.length > input.maxCharacters) continue;
    segments.push(segment);
    characters += segment.text.length;
  }
  return {
    meetingId: ledger.meetingId,
    ownerUserId: ledger.ownerUserId,
    transcriptRevision: ledger.transcriptRevision,
    cursor: ledger.cursor,
    cutoffMs: input.cutoffMs,
    maxSegments: input.maxSegments,
    maxCharacters: input.maxCharacters,
    segments,
    throughMs: segments.length ? Math.max(...segments.map((segment) => segment.endMs)) : null,
    containsProvisional: segments.some((segment) => segment.finality === "provisional"),
    omittedSegments: eligible.length - segments.length
  };
}
