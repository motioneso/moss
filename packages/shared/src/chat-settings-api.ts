import { errorResponseSchema } from "./schema-fragments.js";

export const CHAT_RESPONSE_STYLES = ["concise", "balanced", "detailed"] as const;
export type ChatResponseStyle = (typeof CHAT_RESPONSE_STYLES)[number];
export const CHAT_SETTINGS_PREFERENCE_KEY = "chat.settings.v1";

export interface ChatSettingsDto {
  readonly responseStyle: ChatResponseStyle;
  /** The fast model may be offered locks, doors and garage openers. Off unless the account opts in. */
  readonly frontDoorGuardedDevices: boolean;
  /** This account has turned the fast model off for itself. On means the front door is skipped. */
  readonly frontDoorDisabled: boolean;
}

/** The save request may leave the front-door switch out, which keeps the stored value. */
export interface ChatSettingsUpdateDto {
  readonly responseStyle: ChatResponseStyle;
  readonly frontDoorGuardedDevices?: boolean;
  readonly frontDoorDisabled?: boolean;
}

export interface GetChatSettingsResponse {
  readonly chat: ChatSettingsDto;
}

export interface PutChatSettingsRequest {
  readonly chat: ChatSettingsUpdateDto;
}

export type PutChatSettingsResponse = GetChatSettingsResponse;

export const DEFAULT_CHAT_SETTINGS: ChatSettingsDto = {
  responseStyle: "balanced",
  frontDoorGuardedDevices: false,
  frontDoorDisabled: false
};

export function normalizeChatSettings(value: unknown): ChatSettingsDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CHAT_SETTINGS;
  const raw = value as Record<string, unknown>;
  const responseStyle = isChatResponseStyle(raw.responseStyle)
    ? raw.responseStyle
    : DEFAULT_CHAT_SETTINGS.responseStyle;
  // The front-door flags survive a bad response style, so a damaged row cannot re-enable the fast model.
  return {
    responseStyle,
    frontDoorGuardedDevices: raw.frontDoorGuardedDevices === true,
    frontDoorDisabled: raw.frontDoorDisabled === true
  };
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

/** Applies a save to the stored settings. A field the save omits keeps its stored value. */
export function mergeChatSettings(stored: unknown, update: ChatSettingsUpdateDto): ChatSettingsDto {
  const current = normalizeChatSettings(stored);
  return normalizeChatSettings({
    ...update,
    frontDoorGuardedDevices: update.frontDoorGuardedDevices ?? current.frontDoorGuardedDevices,
    frontDoorDisabled: update.frontDoorDisabled ?? current.frontDoorDisabled
  });
}

const chatSettingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["responseStyle", "frontDoorGuardedDevices", "frontDoorDisabled"],
  properties: {
    responseStyle: { type: "string", enum: CHAT_RESPONSE_STYLES },
    frontDoorGuardedDevices: { type: "boolean" },
    frontDoorDisabled: { type: "boolean" }
  }
} as const;

const chatSettingsUpdateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["responseStyle"],
  properties: {
    responseStyle: { type: "string", enum: CHAT_RESPONSE_STYLES },
    frontDoorGuardedDevices: { type: "boolean" },
    frontDoorDisabled: { type: "boolean" }
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
    properties: { chat: chatSettingsUpdateSchema }
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
