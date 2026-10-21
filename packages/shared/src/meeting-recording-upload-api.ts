/** Resumable transport; intent and source identity are immutable after reservation. */
export interface MeetingRecordingUploadFile {
  readonly byteLength: number;
  readonly sha256: string;
}
export interface MeetingRecordingUploadManifest {
  readonly version: 3;
  readonly sourceDeviceId: string;
  readonly recordingId: string;
  readonly destination:
    | { readonly intent: "meeting" }
    | {
        readonly intent: "voice-request";
        readonly enablementId: string;
        readonly capturedAt: string | null;
      };
  readonly packets: MeetingRecordingUploadFile;
  readonly sidecar: MeetingRecordingUploadFile;
  readonly wav: MeetingRecordingUploadFile;
}
export interface MeetingRecordingUploadProgress {
  readonly id: string;
  readonly fingerprint: string;
  readonly chunkBytes: number;
  readonly expiresAt: string;
  readonly reserved: boolean;
  readonly ready: boolean;
  readonly expired: boolean;
  readonly received: Readonly<Record<"packets" | "sidecar" | "wav", readonly number[]>>;
}
