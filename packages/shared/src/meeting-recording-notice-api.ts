/** Bump the policy version whenever this recording notice changes. */
export const MEETING_RECORDING_NOTICE = {
  policyVersion: "2026-10-06",
  text: "I will tell people when I am recording. Selected audio is sent to the configured transcription service."
} as const;
export interface MeetingRecordingNoticeStatus {
  readonly currentNotice: { readonly policyVersion: string; readonly text: string };
  readonly acknowledgement: {
    readonly policyVersion: string;
    readonly acknowledgedAt: string;
  } | null;
}
export interface AcknowledgeMeetingRecordingNoticeInput {
  /** Must match the version displayed by GET; the acknowledgement time is server-authored. */
  readonly policyVersion: string;
}
