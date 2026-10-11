import type { AccessContext } from "@moss/db";
import type {
  MeetingChatCitation,
  MeetingChatCoverage,
  MeetingChatEvidenceResult,
  MeetingChatSelection,
  MeetingTranscriptEvidence,
  MeetingTranscriptSegment,
  MeetingTranscriptSnapshot
} from "@moss/shared";
import type { StoredMeetingChatContext } from "@moss/shared";
import { neutralizeSeedFraming, sanitizeExternalData } from "./prompt-safety.js";

/** Implemented at the composition root through the Meetings public API and actor data context. */
export interface MeetingContextSource {
  snapshot(
    access: AccessContext,
    meetingId: string,
    query: string
  ): Promise<
    | (MeetingTranscriptSnapshot & {
        readonly personalNotes?: string;
        readonly notesRevision?: number;
      })
    | null
  >;
  isAvailable(access: AccessContext, meetingId: string): Promise<boolean>;
  evidence(
    access: AccessContext,
    evidence: MeetingTranscriptEvidence
  ): Promise<{ readonly segment: MeetingTranscriptSegment; readonly excerpt: string } | null>;
}

export class MeetingContextUnavailableError extends Error {
  constructor() {
    super("The selected meeting is unavailable.");
    this.name = "MeetingContextUnavailableError";
  }
}

export interface BoundMeetingContext extends StoredMeetingChatContext {
  /** Untrusted, escaped evidence. Never use this as a system prompt or action authority. */
  readonly evidenceBlock: string;
  readonly hasEvidence: boolean;
}

const MAX_EVIDENCE_SEGMENTS = 8;
const MAX_EVIDENCE_CHARACTERS = 12_000;

export class MeetingContextService {
  constructor(private readonly source: MeetingContextSource) {}

  async bind(
    access: AccessContext,
    selection: MeetingChatSelection,
    query: string
  ): Promise<BoundMeetingContext> {
    if (!(await this.source.isAvailable(access, selection.meetingId)))
      throw new MeetingContextUnavailableError();
    const snapshot = await this.source.snapshot(access, selection.meetingId, query);
    if (
      !snapshot ||
      snapshot.ownerUserId !== access.actorUserId ||
      snapshot.meetingId !== selection.meetingId
    )
      throw new MeetingContextUnavailableError();

    const notes = (snapshot.personalNotes ?? "").slice(0, 4_000);
    const selected: MeetingTranscriptSegment[] = [];
    let characters = notes.length;
    for (const segment of snapshot.segments) {
      if (segment.text.length === 0) continue;
      if (selected.length >= MAX_EVIDENCE_SEGMENTS) break;
      if (characters + segment.text.length > MAX_EVIDENCE_CHARACTERS) continue;
      if (segment.meetingId !== snapshot.meetingId || segment.endMs > snapshot.cutoffMs)
        throw new MeetingContextUnavailableError();
      selected.push(segment);
      characters += segment.text.length;
    }
    const citations = Object.freeze(
      selected.map(
        (segment, index): MeetingChatCitation =>
          Object.freeze({
            supportId: `S${index + 1}`,
            meetingId: snapshot.meetingId,
            segmentId: segment.segmentId,
            segmentRevision: segment.revision,
            startCharacter: 0,
            endCharacter: segment.text.length,
            startMs: segment.startMs,
            endMs: segment.endMs,
            finality: segment.finality
          })
      )
    );
    const coverage: MeetingChatCoverage = Object.freeze({
      meetingId: snapshot.meetingId,
      selectionId: selection.selectionId,
      transcriptRevision: snapshot.transcriptRevision,
      cursor: snapshot.cursor,
      cutoffMs: snapshot.cutoffMs,
      throughMs: selected.length ? Math.max(...selected.map((segment) => segment.endMs)) : null,
      containsProvisional: selected.some((segment) => segment.finality === "provisional"),
      omittedSegments: snapshot.omittedSegments + snapshot.segments.length - selected.length,
      notesRevision: snapshot.notesRevision ?? 0,
      notesCharacters: notes.length,
      notesTruncated: (snapshot.personalNotes?.length ?? 0) > notes.length
    });
    const payload = JSON.stringify({
      coverage,
      personalNotes: notes,
      evidence: selected.map((segment, index) => ({ ...citations[index], text: segment.text }))
    });
    return Object.freeze({
      ownerUserId: access.actorUserId,
      coverage,
      citations,
      hasEvidence: notes.trim().length > 0 || citations.length > 0,
      evidenceBlock: [
        '<external_source type="meeting_transcript_and_notes">',
        sanitizeExternalData(neutralizeSeedFraming(payload)),
        "</external_source>"
      ].join("\n")
    });
  }

  /** Call immediately before submission/release; errors fail closed rather than answering ungrounded. */
  async assertAvailable(access: AccessContext, context: StoredMeetingChatContext): Promise<void> {
    if (
      context.ownerUserId !== access.actorUserId ||
      !(await this.source.isAvailable(access, context.coverage.meetingId))
    )
      throw new MeetingContextUnavailableError();
  }

  /** Only server-stored citations from this answer are eligible, never a caller-supplied range. */
  async dereference(
    access: AccessContext,
    context: StoredMeetingChatContext,
    supportId: string
  ): Promise<MeetingChatEvidenceResult> {
    if (
      context.ownerUserId !== access.actorUserId ||
      !(await this.source.isAvailable(access, context.coverage.meetingId))
    )
      return { available: false };
    const citation = context.citations.find((item) => item.supportId === supportId);
    if (!citation || citation.meetingId !== context.coverage.meetingId) return { available: false };
    const resolved = await this.source.evidence(access, citation);
    if (
      !resolved ||
      resolved.segment.meetingId !== citation.meetingId ||
      resolved.segment.segmentId !== citation.segmentId ||
      resolved.segment.revision !== citation.segmentRevision ||
      resolved.segment.startMs !== citation.startMs ||
      resolved.segment.endMs !== citation.endMs ||
      resolved.segment.finality !== citation.finality ||
      citation.endCharacter > resolved.segment.text.length ||
      resolved.excerpt !==
        resolved.segment.text.slice(citation.startCharacter, citation.endCharacter)
    )
      return { available: false };
    // Availability may change while the revision query is pending.
    if (!(await this.source.isAvailable(access, citation.meetingId))) return { available: false };
    return { available: true, citation, excerpt: resolved.excerpt };
  }
}
