import { errorResponseSchema, idParamsSchema } from "./schema-fragments.js";

// #3410: whether an API-key provider row can drive chat right now.

export const API_KEY_CHAT_READINESS_STATUSES = [
  "ready",
  "rejected_key",
  "unreachable",
  "needs_key",
  "agent_missing",
  "runner_unavailable"
] as const;

export type ApiKeyChatReadinessStatus = (typeof API_KEY_CHAT_READINESS_STATUSES)[number];

export interface ApiKeyChatReadinessResponse {
  readonly status: ApiKeyChatReadinessStatus;
}

export const apiKeyChatReadinessResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: API_KEY_CHAT_READINESS_STATUSES }
  }
} as const;

export const apiKeyChatReadinessRouteSchema = {
  params: idParamsSchema,
  response: {
    200: apiKeyChatReadinessResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
