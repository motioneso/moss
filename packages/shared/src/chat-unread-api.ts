import { errorResponseSchema } from "./schema-fragments.js";

export interface ChatUnreadResponse {
  readonly unreadCount: number;
  readonly unreadByThread: Readonly<Record<string, number>>;
}

export interface ReadChatMessagesRequest {
  readonly messageIds: readonly string[];
}

export const chatUnreadResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["unreadCount", "unreadByThread"],
  properties: {
    unreadCount: { type: "integer", minimum: 0 },
    unreadByThread: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }
  }
} as const;

export const getChatUnreadRouteSchema = {
  response: { 200: chatUnreadResponseSchema, 401: errorResponseSchema }
} as const;

export const readChatMessagesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } }
} as const;

export const readChatMessagesRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["messageIds"],
    properties: {
      messageIds: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        uniqueItems: true,
        items: { type: "string", format: "uuid" }
      }
    }
  },
  response: {
    200: readChatMessagesResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
