import { errorResponseSchema } from "./schema-fragments.js";

export const CHAT_RESPONSE_STYLES = ["concise", "balanced", "detailed"] as const;
export type ChatResponseStyle = (typeof CHAT_RESPONSE_STYLES)[number];
export const CHAT_SETTINGS_PREFERENCE_KEY = "chat.settings.v1";

export interface ChatSettingsDto {
  readonly responseStyle: ChatResponseStyle;
  /** ACP model selected by the OpenCode card; omitted until the user chooses one. */
  readonly openCodeModel?: "default" | "muse-spark-1.3-free";
}

export interface GetChatSettingsResponse {
  readonly chat: ChatSettingsDto;
}

export interface PutChatSettingsRequest {
  readonly chat: ChatSettingsDto;
}

export type PutChatSettingsResponse = GetChatSettingsResponse;

export const DEFAULT_CHAT_SETTINGS: ChatSettingsDto = { responseStyle: "balanced" };

export function normalizeChatSettings(value: unknown): ChatSettingsDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CHAT_SETTINGS;
  const raw = value as Record<string, unknown>;
  const responseStyle = raw.responseStyle;
  if (!isChatResponseStyle(responseStyle)) return DEFAULT_CHAT_SETTINGS;
  const openCodeModel = raw.openCodeModel;
  return openCodeModel === "default" || openCodeModel === "muse-spark-1.3-free"
    ? { responseStyle, openCodeModel }
    : { responseStyle };
}

export function isChatResponseStyle(value: unknown): value is ChatResponseStyle {
  return typeof value === "string" && CHAT_RESPONSE_STYLES.includes(value as ChatResponseStyle);
}

export function renderChatResponseStyleInstruction(style: ChatResponseStyle): string {
  if (style === "concise") {
    return "Default response style: concise. Prefer short, direct answers unless detail is required.";
  }
  if (style === "detailed") {
    return "Default response style: detailed. Include useful context, reasoning, and next steps.";
  }
  return "Default response style: balanced. Be direct, with enough context to be useful.";
}

const chatSettingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["responseStyle"],
  properties: {
    responseStyle: { type: "string", enum: CHAT_RESPONSE_STYLES },
    openCodeModel: { type: "string", enum: ["default", "muse-spark-1.3-free"] }
  }
} as const;

export const getChatSettingsRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["chat"],
      properties: { chat: chatSettingsSchema }
    },
    401: errorResponseSchema
  }
} as const;

export const putChatSettingsRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["chat"],
    properties: { chat: chatSettingsSchema }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["chat"],
      properties: { chat: chatSettingsSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
