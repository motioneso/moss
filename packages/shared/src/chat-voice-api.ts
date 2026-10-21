import { errorResponseSchema } from "./schema-fragments.js";

export const CHAT_VOICE_REQUEST_STATES = [
  "no-speech",
  "ready-to-send",
  "queued",
  "dispatching",
  "replied",
  "interrupted"
] as const;

export interface ChatVoiceRequestStatus {
  readonly id: string;
  readonly sourceDeviceId: string;
  readonly recordingId: string;
  readonly threadId: string;
  readonly transcript: string;
  readonly state: (typeof CHAT_VOICE_REQUEST_STATES)[number];
  readonly capturedAt: string | null;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string | null;
  readonly statusMessage: string;
}

export const chatVoiceRequestStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "sourceDeviceId",
    "recordingId",
    "threadId",
    "transcript",
    "state",
    "capturedAt",
    "userMessageId",
    "assistantMessageId",
    "statusMessage"
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    sourceDeviceId: { type: "string" },
    recordingId: { type: "string" },
    threadId: { type: "string", format: "uuid" },
    transcript: { type: "string" },
    state: { type: "string", enum: CHAT_VOICE_REQUEST_STATES },
    capturedAt: { type: ["string", "null"] },
    userMessageId: { type: ["string", "null"] },
    assistantMessageId: { type: ["string", "null"] },
    statusMessage: { type: "string" }
  }
} as const;

export const listChatVoiceRequestsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requests"],
  properties: { requests: { type: "array", maxItems: 100, items: chatVoiceRequestStatusSchema } }
} as const;

export const listChatVoiceRequestsRouteSchema = {
  response: {
    200: listChatVoiceRequestsResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const chatVoiceRequestRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  response: {
    200: chatVoiceRequestStatusSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

/** Internal composition contract: only explicit v2 voice intent may reach Chat. */
export interface VoiceRequestInput {
  readonly version: 2;
  readonly intent: "voice-request";
  readonly sourceDeviceId: string;
  readonly recordingId: string;
  readonly sourceFingerprint: string;
  readonly transcriptRevision: number;
  readonly transcript: string;
  readonly capturedAt: string | null;
  /** Set by the versioned receiver only after checking the enablement baseline. */
  readonly automatic: boolean;
}
