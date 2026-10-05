import type { MeetingCaptureSelection } from "./meeting-api.js";

/** Separate, bounded authorization. Neither tm1 nor browser sessions authorize audio upload. */
export const MEETING_CAPTURE_CREDENTIAL_PREFIX = "mm1_";
export const MEETING_CAPTURE_MAX_AUDIO_BYTES = 3840000;
export const MEETING_CAPTURE_MAX_CLIP_MS = 10000;
export const MEETING_CAPTURE_FINALIZATION_MS = 60000;
export type MeetingCapturePermission = "granted" | "denied" | "unknown";
export interface MeetingCaptureInventory {
  readonly microphones: readonly { deviceId: string; sourceId: string; label: string }[];
  readonly applications: readonly { appProcessTreeId: string; label: string }[];
  readonly computerAudio: { available: boolean; excludedProcessTreeIds: readonly string[] };
  readonly microphonePermission: MeetingCapturePermission;
  readonly systemAudioPermission: MeetingCapturePermission;
}
export interface MeetingCaptureObserved {
  readonly generation: number;
  readonly phase: "idle" | "recording" | "paused" | "stopped" | "error";
  readonly errorCode?: string;
}
export interface MeetingCaptureGap {
  readonly id: string;
  readonly sourceId: string;
  readonly epoch: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly reason:
    | "paused"
    | "expired"
    | "buffer-full"
    | "source-unavailable"
    | "processing-failed"
    | "interrupted"
    | "discarded";
}
export interface MeetingCaptureState {
  readonly gaps: readonly MeetingCaptureGap[];
  readonly gapLimitReached: boolean;
  readonly grantId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly generation: number;
  readonly epoch: number;
  readonly desired: "idle" | "recording" | "paused" | "stopped" | "revoked";
  readonly selection: MeetingCaptureSelection | null;
  readonly epochStartMs: number;
  readonly epochEndMs: number | null;
  /** Native truncates to this immutable server-clock-mapped boundary before final flushing. */
  readonly stopCutoffMs: number | null;
  readonly finalizationDeadline: string | null;
  readonly expiresAt: string;
  readonly serverTime: string;
  /** Anchor a native monotonic clock once; do not reset it on later polls. */
  readonly elapsedMs: number;
  readonly inventory: MeetingCaptureInventory | null;
  readonly observed: MeetingCaptureObserved | null;
  readonly lastSeenAt: string | null;
}
export interface MeetingCaptureLinkInput {
  readonly meetingId: string;
  readonly verifierHash: string;
}
export interface MeetingCaptureLink {
  readonly challengeId: string;
  readonly meetingId: string;
  readonly deviceId: string;
  readonly expiresAt: string;
}
export interface MeetingCapturePendingLink extends MeetingCaptureLink {
  readonly deviceName: string;
}
export interface MeetingCaptureRedeemInput {
  readonly meetingId: string;
  readonly challengeId: string;
  readonly verifier: string;
}
export type MeetingCaptureRedeemResult =
  | { readonly status: "pending" }
  | {
      readonly status: "issued";
      readonly credential: string;
      readonly grantId: string;
      readonly expiresAt: string;
    };
export interface MeetingCaptureStatusInput {
  readonly gaps?: readonly MeetingCaptureGap[];
  readonly meetingId: string;
  readonly grantId: string;
  readonly inventory: MeetingCaptureInventory;
  readonly observed: MeetingCaptureObserved;
}
export interface MeetingCaptureControlInput {
  readonly grantId: string;
  readonly requestKey: string;
  readonly expectedGeneration: number;
  readonly command: "record" | "pause" | "stop" | "revoke";
  readonly selection?: MeetingCaptureSelection;
  readonly noticeAcknowledged?: true;
}
export interface MeetingCaptureAudioInput {
  readonly meetingId: string;
  readonly grantId: string;
  readonly requestKey: string;
  /** The recording generation for this epoch, also during its bounded final flush. */
  readonly generation: number;
  readonly epoch: number;
  readonly sourceId: string;
  readonly sequence: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly sampleRateHz: number;
  /** Mono signed 16-bit little endian samples. Transport only; never persisted. */
  readonly pcmBase64: string;
}
export interface MeetingCaptureAudioReceipt {
  readonly requestKey: string;
  readonly status: "pending" | "saved" | "failed";
  readonly transcriptRevision?: number;
  readonly code?: string;
  readonly replayed?: boolean;
}
export interface MeetingCaptureBrowserStatus {
  readonly pendingLinks: readonly MeetingCapturePendingLink[];
  readonly capture: MeetingCaptureState | null;
  readonly processingReady: boolean;
}
