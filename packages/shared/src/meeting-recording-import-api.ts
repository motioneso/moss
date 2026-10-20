/** Completed legacy recordings are supplied evidence, never live capture or executable requests. */
export interface MeetingRecordingFile {
  readonly name: string;
  readonly base64: string;
  readonly sha256: string;
}
export interface MeetingRecordingImportInput {
  readonly version: 1;
  readonly sourceDeviceId: string;
  readonly recordingId: string;
  readonly packets: MeetingRecordingFile;
  readonly sidecar: MeetingRecordingFile;
  readonly wav: MeetingRecordingFile;
}
export type MeetingRecordingImportErrorCode =
  | "import_interrupted"
  | "transcription_unavailable"
  | "transcription_failed"
  | "import_unavailable";
export interface MeetingRecordingImportStatus {
  readonly id: string;
  readonly meetingId: string;
  readonly state: "queued" | "transcribing" | "complete" | "failed";
  readonly mode: "normal" | "voice-request";
  readonly durationMs: number;
  readonly bookmarksMs: readonly number[];
  readonly code: MeetingRecordingImportErrorCode | null;
  readonly retryable: boolean;
}
