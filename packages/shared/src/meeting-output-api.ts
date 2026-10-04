import type {
  MeetingTranscriptEvidence,
  MeetingTranscriptSnapshot
} from "./meeting-transcript-api.js";

export type MeetingOutputEvidence =
  | (MeetingTranscriptEvidence & { readonly kind: "transcript" })
  | {
      readonly kind: "personal-note";
      readonly meetingId: string;
      readonly notesRevision: number;
      readonly startCharacter: number;
      readonly endCharacter: number;
    };
export interface MeetingOutputClaim {
  readonly text: string;
  readonly evidence: readonly MeetingOutputEvidence[];
}
export interface MeetingOutputAction extends MeetingOutputClaim {
  readonly ownerPhrase: string | null;
  readonly duePhrase: string | null;
}
export interface MeetingOutputContent {
  readonly overview: string;
  readonly decisions: readonly MeetingOutputClaim[];
  readonly openQuestions: readonly string[];
  readonly actions: readonly MeetingOutputAction[];
  readonly warnings: readonly string[];
}
export interface MeetingOutputInputs {
  readonly meetingId: string;
  readonly transcript: MeetingTranscriptSnapshot | null;
  readonly personalNotes: string;
  readonly notesRevision: number;
}
export interface GenerateMeetingOutputInput {
  readonly requestKey: string;
  readonly expectedOutputVersion: number;
  readonly expectedTranscriptRevision: number;
  readonly expectedNotesRevision: number;
  readonly templateId: "general" | "one-to-one" | "project-review" | "interview";
  readonly templateVersion: number;
}
export interface MeetingOutputArtifact {
  readonly id: string;
  readonly meetingId: string;
  readonly version: number;
  readonly inputs: MeetingOutputInputs;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly modelRoute: string;
  readonly content: MeetingOutputContent;
  readonly origin: "generated" | "manual";
  readonly stale: boolean;
  readonly createdAt: string;
}
export interface MeetingActionCandidate {
  readonly id: string;
  readonly meetingId: string;
  readonly artifactVersion: number;
  readonly proposal: MeetingOutputAction;
  readonly reviewState: "pending" | "accepted" | "dismissed";
  readonly acceptedTaskId: string | null;
  readonly possibleMatchIds: readonly string[];
}
export interface EditMeetingOutputInput {
  readonly requestKey: string;
  readonly expectedOutputVersion: number;
  readonly content: MeetingOutputContent;
}
export interface ReviewMeetingActionInput {
  readonly requestKey: string;
  readonly decision: "accept" | "dismiss";
  /** Required for acceptance: owner reviews the title; relative dates are never auto-resolved. */
  readonly title?: string;
  readonly dueAt?: string | null;
  /** Explicit acknowledgment when a new proposal may overlap previous candidates. */
  readonly createDespitePossibleMatches?: boolean;
}
export type MeetingOutputResult =
  | { readonly status: "pending" | "failed"; readonly requestKey: string; readonly code?: string }
  | {
      readonly status: "saved";
      readonly artifact: MeetingOutputArtifact;
      readonly replayed: boolean;
    };
