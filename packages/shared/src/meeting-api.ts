/** Wire contracts only. Native capture, authorization and provider routing are not implemented here. */
export type MeetingSourceHealth =
  | "audio"
  | "silence"
  | "muted"
  | "disconnected"
  | "permission-missing"
  | "no-stream"
  | "not-captured";

export interface MeetingMicrophone {
  readonly sourceId: string;
  readonly deviceId: string;
}

export type MeetingCaptureSelection = {
  readonly microphone: MeetingMicrophone;
} & (
  | { readonly mode: "microphone-only" }
  | {
      readonly mode: "selected-app";
      readonly outputSourceId: string;
      readonly appProcessTreeId: string;
      readonly applicationId?: string;
    }
  | {
      readonly mode: "computer-audio";
      readonly outputSourceId: string;
      /** Endpoint loopback is limited to this device, never implicitly all outputs. */
      readonly scope:
        | { readonly kind: "endpoint"; readonly endpointId: string }
        | {
            readonly kind: "process-exclusion";
            readonly excludedProcessTreeIds: readonly string[];
          };
    }
);

/** Independently declared capabilities; a transcription model implies no speaker capability. */
export interface MeetingProcessingCapabilities {
  readonly transcription: {
    readonly profileId: string;
    readonly profileVersion: number;
    readonly transport: "chunks" | "streaming";
    readonly timestamps: boolean;
    readonly revisions: boolean;
  };
  readonly speakers:
    | { readonly kind: "source-labels-only" }
    | { readonly kind: "diarization"; readonly profileId: string; readonly profileVersion: number };
  readonly summary: { readonly profileId: string; readonly profileVersion: number } | null;
  readonly chat: { readonly profileId: string; readonly profileVersion: number } | null;
}

export interface MeetingReadiness {
  readonly microphone: MeetingSourceHealth;
  readonly output: MeetingSourceHealth;
  readonly permissionsGranted: boolean;
  readonly processingReady: boolean;
  readonly noticeAcknowledged: boolean;
}

export interface MeetingSourceBoundary {
  readonly sourceId: string;
  /** Inclusive last sequence; null means this source produced no envelopes in this epoch. */
  readonly finalSequence: number | null;
}

export interface MeetingCaptureEpoch {
  readonly epoch: number;
  readonly selection: MeetingCaptureSelection;
  readonly startMs: number;
  readonly endMs: number | null;
  readonly boundaries: readonly MeetingSourceBoundary[];
}

export interface MeetingAudioEnvelope {
  readonly meetingId: string;
  readonly sourceId: string;
  readonly epoch: number;
  readonly sequence: number;
  /** Half-open interval on the shared monotonic meeting clock. */
  readonly startMs: number;
  readonly endMs: number;
  readonly format: "pcm-s16le";
  readonly sampleRateHz: number;
  readonly channels: 1;
  readonly contentHash: string;
}

const identifierSchema = { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" } as const;
const offsetSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const counterSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

/** Structural validation; lifecycle rules also validate intervals and epoch membership. */
export const meetingAudioEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "meetingId",
    "sourceId",
    "epoch",
    "sequence",
    "startMs",
    "endMs",
    "format",
    "sampleRateHz",
    "channels",
    "contentHash"
  ],
  properties: {
    meetingId: identifierSchema,
    sourceId: identifierSchema,
    epoch: { ...counterSchema, minimum: 1 },
    sequence: counterSchema,
    startMs: offsetSchema,
    endMs: offsetSchema,
    format: { type: "string", enum: ["pcm-s16le"] },
    sampleRateHz: { type: "integer", minimum: 8000, maximum: 192000 },
    channels: { type: "integer", enum: [1] },
    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" }
  }
} as const;
