// packages/shared/src/news-credentials-api.ts — BROWSER-SAFE. No node:* imports.
//
// News publisher credential contracts (#2005, part of #950). Deliberately its own file
// rather than an addition to news-api.ts, which is already close to the 1000-line cap
// enforced by `pnpm check:file-size`.
//
// SECURITY: no type and no response schema in this file may ever declare an apiKey, an
// encryption envelope, a request header name, or the credential generation. The response
// schema is what actually strips unknown fields on the way out, so the absence is load
// bearing, not decorative — tests/unit/news-credential-routes.test.ts pins it.
import { errorResponseSchema } from "./schema-fragments.js";
import type { NewsCustomSourceDto } from "./news-api.js";

/** Longest access key a publisher connection may be given. Bounds the request body. */
export const NEWS_CREDENTIAL_MAX_KEY_LENGTH = 512;
/** Longest reviewed-connection identifier. Matches the column check in migration 0200. */
export const NEWS_CREDENTIAL_MAX_CONNECTION_ID_LENGTH = 64;

/** Fixed user-facing wording. Chosen by branching on a typed outcome, never generated. */
export const NEWS_CREDENTIAL_MESSAGES = {
  unsupported: "This publisher needs an access method News does not support yet.",
  rejected: "The publisher rejected this key. Your previous key is still active.",
  unavailable: "The publisher could not be reached. Try again later.",
  revoked: "Access revoked. Add a new key to reconnect this source.",
  connected: "Connected. News will use this source on its next refresh."
} as const;

/**
 * #2008: what News tells the user about a reviewed publisher connection BEFORE they type a key.
 *
 * SECURITY: these five display fields are the whole offer. No header name, no endpoint, no
 * query table and obviously no key. `requestHost` is the one technical detail the user needs,
 * because it is the exact place their key will be sent.
 */
export interface NewsPublisherConnectionOfferDto {
  readonly connectionId: string;
  readonly publisherName: string;
  /** Exact HTTPS host the key will be sent to. Shown before the user types anything. */
  readonly requestHost: string;
  readonly accessSummary: string;
  readonly termsUrl: string | null;
}

export const newsPublisherConnectionOfferSchema = {
  type: "object",
  additionalProperties: false,
  required: ["connectionId", "publisherName", "requestHost", "accessSummary", "termsUrl"],
  properties: {
    connectionId: { type: "string" },
    publisherName: { type: "string" },
    requestHost: { type: "string" },
    accessSummary: { type: "string" },
    termsUrl: { type: ["string", "null"] }
  }
} as const;

/**
 * What a user may learn about their own stored credential. There is no
 * 'not_configured' row in the database — a source with no credential has no row, and
 * this status reports not_configured for that case.
 */
export interface NewsSourceCredentialStatusDto {
  readonly sourceId: string;
  readonly connectionId: string;
  readonly publisherName: string;
  /**
   * #2008: the exact HTTPS host this stored key is sent to, taken from the reviewed connection
   * itself. Null when the connection is no longer declared, in which case News cannot honestly
   * say where a replacement key would go and does not offer to take one.
   *
   * This is the same field as the offer's `requestHost`, and for the same reason: a screen that
   * promises where a secret goes must build that promise from the request, not from whatever
   * domain happens to be stored next to it.
   */
  readonly requestHost: string | null;
  readonly status: "not_configured" | "configured" | "revoked";
  readonly lastValidatedAt: string | null;
  readonly revokedAt: string | null;
}

export interface ConnectNewsCredentialedSourceRequest {
  readonly connectionId: string;
  readonly apiKey: string;
}

export interface ReplaceNewsSourceCredentialRequest {
  readonly apiKey: string;
}

export interface ConnectNewsCredentialedSourceResponse {
  readonly source: NewsCustomSourceDto;
  readonly credential: NewsSourceCredentialStatusDto;
  readonly message: string;
}

export interface NewsSourceCredentialResponse {
  readonly credential: NewsSourceCredentialStatusDto;
  readonly message: string;
}

export interface NewsSourceCredentialsResponse {
  readonly credentials: readonly NewsSourceCredentialStatusDto[];
}

const newsSourceCredentialStatusDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceId",
    "connectionId",
    "publisherName",
    "requestHost",
    "status",
    "lastValidatedAt",
    "revokedAt"
  ],
  properties: {
    sourceId: { type: "string" },
    connectionId: { type: "string" },
    publisherName: { type: "string" },
    requestHost: { type: ["string", "null"] },
    status: { type: "string", enum: ["not_configured", "configured", "revoked"] },
    lastValidatedAt: { type: ["string", "null"] },
    revokedAt: { type: ["string", "null"] }
  }
} as const;

// Mirrors newsCustomSourceDtoSchema in news-api.ts; repeated here so this file's response
// schemas are self-contained and additionalProperties:false applies at every level.
const credentialedNewsSourceDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "label",
    "canonicalDomain",
    "homepageUrl",
    "feedUrl",
    "retrievalMethod",
    "validationStatus",
    "healthStatus",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    canonicalDomain: { type: "string" },
    homepageUrl: { type: "string" },
    feedUrl: { type: ["string", "null"] },
    retrievalMethod: { type: "string", enum: ["feed", "scrape"] },
    validationStatus: { type: "string", enum: ["approved", "needs_revalidation", "rejected"] },
    healthStatus: { type: "string", enum: ["available", "unavailable"] },
    createdAt: { type: "string" }
  }
} as const;

export const connectNewsCredentialedSourceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["connectionId", "apiKey"],
    properties: {
      connectionId: {
        type: "string",
        minLength: 1,
        maxLength: NEWS_CREDENTIAL_MAX_CONNECTION_ID_LENGTH
      },
      apiKey: { type: "string", minLength: 1, maxLength: NEWS_CREDENTIAL_MAX_KEY_LENGTH }
    }
  },
  response: {
    201: {
      type: "object",
      additionalProperties: false,
      required: ["source", "credential", "message"],
      properties: {
        source: credentialedNewsSourceDtoSchema,
        credential: newsSourceCredentialStatusDtoSchema,
        message: { type: "string" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    409: errorResponseSchema,
    422: errorResponseSchema,
    502: errorResponseSchema
  }
} as const;

export const replaceNewsSourceCredentialSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" }
    }
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", minLength: 1, maxLength: NEWS_CREDENTIAL_MAX_KEY_LENGTH }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["credential", "message"],
      properties: {
        credential: newsSourceCredentialStatusDtoSchema,
        message: { type: "string" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    422: errorResponseSchema,
    502: errorResponseSchema
  }
} as const;

export const revokeNewsSourceCredentialSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", format: "uuid" }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["credential", "message"],
      properties: {
        credential: newsSourceCredentialStatusDtoSchema,
        message: { type: "string" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const listNewsSourceCredentialsSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["credentials"],
      properties: {
        credentials: { type: "array", items: newsSourceCredentialStatusDtoSchema }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;
