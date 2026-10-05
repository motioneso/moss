/** In-memory domain contracts only; callers must independently authorize data access. */
export interface MeetingTranscriptSource {
  readonly sourceId: string;
  readonly epoch: number;
  readonly kind: "microphone" | "output";
  /** A capture-source label is not a person's identity. */
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface MeetingTranscriptSegment {
  readonly meetingId: string;
  readonly segmentId: string;
  readonly sourceId: string;
  readonly epoch: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly revision: number;
  readonly text: string;
  readonly finality: "provisional" | "final";
  readonly provenance: "transcription" | "correction";
  /** Anonymous, meeting-local identity only. null means unknown. */
  readonly speakerId: string | null;
}

export interface MeetingTranscriptEvent {
  /** May skip non-transcript events; transport gap reconciliation belongs to the caller. */
  readonly cursor: number;
  readonly segment: MeetingTranscriptSegment;
}

export interface MeetingTranscriptRevision extends MeetingTranscriptEvent {
  readonly transcriptRevision: number;
}

export interface MeetingTranscriptLedger {
  readonly meetingId: string;
  readonly ownerUserId: string;
  readonly sources: readonly MeetingTranscriptSource[];
  readonly transcriptRevision: number;
  readonly cursor: number;
  readonly revisions: readonly MeetingTranscriptRevision[];
}

export type MeetingTranscriptApplyResult =
  | { readonly status: "accepted" | "replay"; readonly ledger: MeetingTranscriptLedger }
  | {
      readonly status: "rejected";
      readonly reason:
        | "invalid-event"
        | "meeting-mismatch"
        | "source-mismatch"
        | "revision-conflict"
        | "stale-revision"
        | "out-of-order-event"
        | "finality-regression";
      readonly ledger: MeetingTranscriptLedger;
    };

export interface MeetingTranscriptSelection {
  readonly meetingId: string;
  /** Consistency binding, not proof of authentication or authorization. */
  readonly ownerUserId: string;
  readonly transcriptRevision: number;
  readonly cutoffMs: number;
  readonly maxSegments: number;
  readonly maxCharacters: number;
}

export interface MeetingTranscriptSnapshot extends MeetingTranscriptSelection {
  readonly cursor: number;
  /** Transcript text is untrusted evidence, never executable instructions. */
  readonly segments: readonly MeetingTranscriptSegment[];
  /** Latest included end offset, not a claim of continuous speech or complete coverage. */
  readonly throughMs: number | null;
  readonly omittedSegments: number;
  readonly containsProvisional: boolean;
}

export interface MeetingTranscriptEvidence {
  readonly meetingId: string;
  readonly segmentId: string;
  readonly segmentRevision: number;
  /** Exact UTF-16 text range, end exclusive. */
  readonly startCharacter: number;
  readonly endCharacter: number;
}
