import { errorResponseSchema } from "./schema-fragments.js";

/**
 * Admin Web Search (Brave) API key contract. The key itself is AES-256-GCM encrypted at rest
 * and NEVER leaves the server — responses carry only `configured` + `source`, never the key or
 * ciphertext. `source` reports where a configured key comes from: the encrypted instance
 * setting, the `JARVIS_BRAVE_SEARCH_API_KEY` env fallback, or null when unconfigured.
 */
export type WebSearchKeySource = "instance" | "env" | null;

export interface WebSearchKeyStatusDto {
  readonly configured: boolean;
  readonly source: WebSearchKeySource;
  readonly nativeSearchEnabled: boolean;
}

export interface GetWebSearchKeyResponse {
  readonly status: WebSearchKeyStatusDto;
}

export interface PutWebSearchKeyRequest {
  readonly apiKey?: string;
  readonly nativeSearchEnabled?: boolean;
}

export type PutWebSearchKeyResponse = GetWebSearchKeyResponse;
export type DeleteWebSearchKeyResponse = GetWebSearchKeyResponse;

const webSearchKeyStatusSchema = {
  type: "object",
  additionalProperties: false,
  required: ["configured", "source", "nativeSearchEnabled"],
  properties: {
    configured: { type: "boolean" },
    source: { type: ["string", "null"], enum: ["instance", "env", null] },
    nativeSearchEnabled: { type: "boolean" }
  }
} as const;

const statusEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: webSearchKeyStatusSchema }
} as const;

export const getWebSearchKeyRouteSchema = {
  response: {
    200: statusEnvelopeSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const putWebSearchKeyRouteSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      apiKey: { type: "string", minLength: 1, maxLength: 500 },
      nativeSearchEnabled: { type: "boolean" }
    }
  },
  response: {
    200: statusEnvelopeSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export const deleteWebSearchKeyRouteSchema = {
  response: {
    200: statusEnvelopeSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;
