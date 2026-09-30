import { errorResponseSchema } from "./schema-fragments.js";

// #2810: the per-user list of starred chat models shown under Favorites in the chat model picker.

export const CHAT_MODEL_FAVORITES_MAX = 100;

export interface ChatModelFavoritesDto {
  readonly modelIds: readonly string[];
}

export type GetChatModelFavoritesResponse = ChatModelFavoritesDto;
export type PutChatModelFavoritesRequest = ChatModelFavoritesDto;

export const chatModelFavoritesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["modelIds"],
  properties: {
    modelIds: {
      type: "array",
      maxItems: CHAT_MODEL_FAVORITES_MAX,
      items: { type: "string", minLength: 1, maxLength: 200 }
    }
  }
} as const;

export const getChatModelFavoritesRouteSchema = {
  response: {
    200: chatModelFavoritesSchema,
    401: errorResponseSchema
  }
} as const;

export const putChatModelFavoritesRouteSchema = {
  body: chatModelFavoritesSchema,
  response: {
    200: chatModelFavoritesSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;
