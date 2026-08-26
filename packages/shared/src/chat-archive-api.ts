import { errorResponseSchema } from "./schema-fragments.js";

export interface ChatArchiveStatus {
  readonly state: "paused" | "failed";
  readonly reason: string;
}

export interface ChatArchiveSettingsResponse {
  readonly enabled: boolean;
  readonly folder: string;
  readonly status: ChatArchiveStatus | null;
}

export interface PutChatArchiveSettingsRequest {
  readonly enabled: boolean;
  readonly folder: string;
}

/**
 * Validates a chat-archive folder value: a vault-relative path, no leading slash, no ".."
 * segment, no embedded null byte. Nested folders are allowed. Throws a plain-English `Error` on
 * rejection; callers decide how to surface it (route: 400, writer: no-op).
 */
export function validateChatArchiveFolder(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("Chat archive folder must be a string");
  }
  if (input.trim().length === 0) {
    throw new Error("Chat archive folder cannot be empty");
  }
  if (input.includes("\u0000")) {
    throw new Error("Chat archive folder cannot contain a null byte");
  }
  if (input.startsWith("/")) {
    throw new Error("Chat archive folder cannot start with a leading slash");
  }
  if (input.split("/").includes("..")) {
    throw new Error('Chat archive folder cannot contain a ".." segment');
  }
  return input;
}

const chatArchiveSettingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "folder"],
  properties: {
    enabled: { type: "boolean" },
    folder: { type: "string", minLength: 1 }
  }
} as const;

const chatArchiveStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "reason"],
  properties: {
    state: { type: "string", enum: ["paused", "failed"] },
    reason: { type: "string" }
  }
} as const;

const chatArchiveSettingsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "folder", "status"],
  properties: {
    enabled: { type: "boolean" },
    folder: { type: "string", minLength: 1 },
    status: { anyOf: [chatArchiveStatusSchema, { type: "null" }] }
  }
} as const;

export const getChatArchiveSettingsRouteSchema = {
  response: {
    200: chatArchiveSettingsResponseSchema,
    default: errorResponseSchema
  }
} as const;

export const putChatArchiveSettingsRouteSchema = {
  body: chatArchiveSettingsSchema,
  response: getChatArchiveSettingsRouteSchema.response
} as const;
