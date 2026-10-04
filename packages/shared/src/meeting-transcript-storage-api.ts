import type {
  MeetingTranscriptEvent,
  MeetingTranscriptSnapshot,
  MeetingTranscriptSource
} from "./meeting-transcript-api.js";

/** Text ingestion only. Source bounds are supplied metadata, not verified native capture. */
export interface IngestMeetingTranscriptInput {
  readonly meetingId: string;
  readonly requestKey: string;
  readonly expectedVersion: number;
  readonly sources: readonly MeetingTranscriptSource[];
  readonly events: readonly MeetingTranscriptEvent[];
  /** Once set, this cutoff cannot change. Later pre-cutoff corrections remain possible. */
  readonly stopCutoffMs: number | null;
}
export interface MeetingTranscriptReceipt {
  readonly version: number;
  readonly transcriptRevision: number;
  readonly cursor: number;
  readonly stopCutoffMs: number | null;
}
export type IngestMeetingTranscriptResult =
  | {
      readonly status: "saved";
      readonly replayed: boolean;
      readonly receipt: MeetingTranscriptReceipt;
    }
  | { readonly status: "conflict"; readonly receipt: MeetingTranscriptReceipt }
  | { readonly status: "not-found" };
export interface ReadMeetingTranscriptInput {
  readonly transcriptRevision?: number;
  readonly cutoffMs?: number;
  readonly maxSegments: number;
  readonly maxCharacters: number;
}
const counter = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const identifier = { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" } as const;
const uuid = { type: "string", format: "uuid" } as const;
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: uuid }
} as const;
const source = {
  type: "object",
  additionalProperties: false,
  required: ["sourceId", "epoch", "kind", "label", "startMs", "endMs"],
  properties: {
    sourceId: identifier,
    epoch: { ...counter, minimum: 1 },
    kind: { type: "string", enum: ["microphone", "output"] },
    label: identifier,
    startMs: counter,
    endMs: counter
  }
} as const;
const segment = {
  type: "object",
  additionalProperties: false,
  required: [
    "meetingId",
    "segmentId",
    "sourceId",
    "epoch",
    "startMs",
    "endMs",
    "revision",
    "text",
    "finality",
    "provenance",
    "speakerId"
  ],
  properties: {
    meetingId: uuid,
    segmentId: identifier,
    sourceId: identifier,
    epoch: { ...counter, minimum: 1 },
    startMs: counter,
    endMs: counter,
    revision: { ...counter, minimum: 1 },
    text: { type: "string", maxLength: 100000 },
    finality: { type: "string", enum: ["provisional", "final"] },
    provenance: { type: "string", enum: ["transcription", "correction"] },
    speakerId: { anyOf: [{ const: null }, identifier] }
  }
} as const;
export const ingestMeetingTranscriptSchema = {
  params,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["requestKey", "expectedVersion", "sources", "events", "stopCutoffMs"],
    properties: {
      requestKey: uuid,
      expectedVersion: { ...counter, maximum: 4095 },
      sources: { type: "array", minItems: 1, maxItems: 128, items: source },
      events: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["cursor", "segment"],
          properties: { cursor: { ...counter, minimum: 1 }, segment }
        }
      },
      stopCutoffMs: { anyOf: [{ const: null }, counter] }
    }
  }
} as const;
export const readMeetingTranscriptSchema = {
  params,
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["maxSegments", "maxCharacters"],
    properties: {
      transcriptRevision: counter,
      cutoffMs: counter,
      maxSegments: { type: "integer", minimum: 1, maximum: 500 },
      maxCharacters: { type: "integer", minimum: 1, maximum: 100000 }
    }
  }
} as const;
export const readMeetingTranscriptEvidenceSchema = {
  params,
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["segmentId", "segmentRevision", "startCharacter", "endCharacter"],
    properties: {
      segmentId: identifier,
      segmentRevision: { ...counter, minimum: 1 },
      startCharacter: counter,
      endCharacter: counter
    }
  }
} as const;

export interface MeetingTranscriptSnapshotResponse {
  readonly snapshot: MeetingTranscriptSnapshot;
  readonly sources: readonly MeetingTranscriptSource[];
}
