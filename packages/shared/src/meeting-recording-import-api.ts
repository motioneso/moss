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

/** Intent must be opted into after a complete ring inventory snapshot. */
export interface VoiceRecordingImportInput {
  readonly version: 2;
  readonly intent: "voice-request";
  readonly enablementId: string;
  /** Phone-observed capture time, or null when timing is uncertain. */
  readonly capturedAt: string | null;
  readonly recording: MeetingRecordingImportInput;
}
export interface VoiceRecordingImportStatus {
  readonly id: string;
  readonly state: MeetingRecordingImportStatus["state"];
  readonly intent: "voice-request";
  readonly voiceRequestId: string | null;
  readonly code: MeetingRecordingImportStatus["code"];
  readonly retryable: boolean;
}
