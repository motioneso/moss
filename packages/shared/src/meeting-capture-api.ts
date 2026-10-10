import type { MeetingCaptureSelection } from "./meeting-api.js";

/** Separate, bounded authorization. Neither tm1 nor browser sessions authorize audio upload. */
export const MEETING_CAPTURE_CREDENTIAL_PREFIX = "mm1_";
export const MEETING_CAPTURE_MAX_AUDIO_BYTES = 3840000;
export const MEETING_CAPTURE_MAX_CLIP_MS = 10000;
export const MEETING_CAPTURE_FINALIZATION_MS = 60000;
export const MEETING_CAPTURE_LEASE_MS = 30000;
export const MEETING_CAPTURE_CLAIM_MS = 60000;
export type MeetingCapturePermission = "granted" | "denied" | "unknown";
export interface MeetingCaptureInventory {
  readonly defaultMicrophoneId?: string | null;
  readonly microphones: readonly { deviceId: string; sourceId: string; label: string }[];
  readonly applications: readonly {
    appProcessTreeId: string;
    applicationId?: string;
    label: string;
  }[];
  readonly computerAudio: { available: boolean; excludedProcessTreeIds: readonly string[] };
  readonly microphonePermission: MeetingCapturePermission;
  readonly systemAudioPermission: MeetingCapturePermission;
}
export interface MeetingCaptureObserved {
  readonly generation: number;
  readonly phase: "idle" | "recording" | "recovering" | "paused" | "stopped" | "error";
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
export type MeetingCaptureRevocationReason =
  | "device-unavailable"
  | "recording-permission-revoked"
  | "session-ended"
  | "connection-replaced"
  | "expired";
export interface MeetingCaptureState {
  readonly revocationReason?: MeetingCaptureRevocationReason;
  readonly revision?: string;
  readonly transcriptRevision?: number;
  readonly leaseMs?: number;
  readonly recordedDurationMs?: number;
  readonly finalization?: "none" | "pending" | "complete";
  readonly processing?: MeetingCaptureProcessingState;
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
  readonly finalized?: boolean;
  /** Native acknowledged cumulative recording time, excluding paused/idle time. */
  readonly recordedDurationMs?: number;
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
}
/** Only the claimed native recorder may change sources or recover its identical live selection. */
export type MeetingCaptureNativeControlInput = {
  readonly meetingId: string;
  readonly grantId: string;
  readonly requestKey: string;
  readonly expectedGeneration: number;
} & (
  | {
      readonly command: "record" | "pause" | "stop";
      readonly selection?: never;
      readonly expectedEpoch?: never;
    }
  | {
      readonly command: "change-sources" | "recover-sources";
      readonly expectedEpoch: number;
      readonly selection: MeetingCaptureSelection;
    }
);
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
  readonly reason?: string;
  readonly stage?: MeetingCaptureFailureStage;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  readonly replayed?: boolean;
}
export interface MeetingCaptureBrowserStatus {
  readonly revision?: string;
  readonly retryAfterMs?: number;
  readonly pendingLinks: readonly MeetingCapturePendingLink[];
  readonly capture: MeetingCaptureState | null;
  readonly processingReady: boolean;
}

export type MeetingCaptureFailureStage =
  | "configuration"
  | "dispatch"
  | "response"
  | "validation"
  | "persistence"
  | "authorization";
export interface MeetingCaptureProcessingFailure {
  readonly code: string;
  readonly reason: string;
  readonly stage: MeetingCaptureFailureStage;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
}
export interface MeetingCaptureProcessingState {
  readonly status: "ready" | "delayed";
  readonly reason?: string;
  readonly stage?: MeetingCaptureFailureStage;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
}
export interface MeetingCaptureConnectionInput {
  readonly connectionId: string;
  readonly verifierHash: string;
  readonly inventory: MeetingCaptureInventory;
}
export interface MeetingCaptureConnectionResult {
  readonly connectionId: string;
  readonly revision: number;
  readonly leaseMs: number;
  readonly expiresAt: string;
}
export interface MeetingCaptureDevice {
  readonly busy?: boolean;
  readonly capturePhase?: "starting" | "recording" | "paused" | "finalizing" | null;
  readonly finalizationDeadline?: string | null;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly capabilityRevision: number;
  readonly inventory: MeetingCaptureInventory;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}
export interface MeetingCaptureDevicesResult {
  readonly devices: readonly MeetingCaptureDevice[];
  readonly processingReady: boolean;
}
export interface MeetingCaptureStartInput {
  readonly requestKey: string;
}
/** Accepted only to replay an already-issued pre-minimal Start with its exact fingerprint. */
export interface MeetingCaptureLegacyStartInput {
  readonly deviceId: string;
  readonly connectionId: string;
  readonly expectedRevision: number;
  readonly requestKey: string;
  readonly selection: MeetingCaptureSelection;
}
export type MeetingCaptureStartRequest = MeetingCaptureStartInput | MeetingCaptureLegacyStartInput;
export interface MeetingCaptureCommandsInput {
  readonly connectionId: string;
  readonly verifier: string;
  readonly revision?: string;
  readonly waitMs?: number;
}
export interface MeetingCaptureCommandsResult {
  readonly revision: string;
  readonly retryAfterMs: number;
  readonly command: null | {
    readonly meetingId: string;
    readonly grantId: string;
    readonly ownerUserId: string;
    readonly generation: number;
    readonly capabilityRevision: number;
    /** The deadline to claim this explicit Start. */
    readonly expiresAt: string;
    readonly selection: MeetingCaptureSelection;
  };
}
export interface MeetingCaptureClaimInput {
  readonly connectionId: string;
  readonly verifier: string;
  readonly grantId: string;
  /** SHA256 hex digest of the complete, native-created mm1 bearer. */
  readonly credentialHash: string;
}
export interface MeetingCaptureClaimResult {
  readonly meetingId: string;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly capture: MeetingCaptureState;
}

export type MeetingCaptureDevicesResponse = MeetingCaptureDevicesResult;

export interface MeetingCaptureCancelStartInput {
  readonly deviceId?: string;
  readonly connectionId?: string;
  /** Original explicit Start key. Cancels even when Start has not reached the server. */
  readonly requestKey: string;
}
export interface MeetingCaptureCancelStartResult {
  readonly cancelled: true;
  readonly capture: MeetingCaptureState | null;
}
