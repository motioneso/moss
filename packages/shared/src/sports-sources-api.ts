// packages/shared/src/sports-sources-api.ts — BROWSER-SAFE. No node:* imports.
// #1572 Custom public news sources by team and league — URL-only, mirrors
// news-api.ts's NewsCustomSourceDto/preview/confirm shapes with a single
// candidate (no name/web-search ambiguity) and a follow-assignment list.
import { errorResponseSchema } from "./schema-fragments.js";

export type SportsSourceHealthState =
  | "pending"
  | "healthy"
  | "failing"
  | "unsupported"
  | "auth_required"
  | "disabled";

export interface SportsCustomSourceDto {
  readonly id: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape";
  readonly enabled: boolean;
  readonly healthState: SportsSourceHealthState;
  readonly healthReasonCode: string | null;
  readonly healthMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly assignedFollowIds: readonly string[];
  readonly createdAt: string;
}

export interface SportsCustomSourcesResponse {
  readonly sources: readonly SportsCustomSourceDto[];
}

export interface PreviewSportsSourceRequest {
  readonly url: string;
}

export interface PreviewSportsSourceCandidate {
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly retrievalMethod: "feed" | "scrape";
  readonly sampleCount: number;
}

export interface PreviewSportsSourceResponse {
  readonly status: "ok" | "rejected" | "unavailable";
  readonly confirmationId?: string;
  readonly candidate?: PreviewSportsSourceCandidate;
  readonly reason?: string;
  readonly duplicateOfSourceId?: string;
}

export interface ConfirmSportsSourceRequest {
  readonly confirmationId: string;
  readonly followIds?: readonly string[];
}

export interface ConfirmSportsSourceResponse {
  readonly source: SportsCustomSourceDto;
}

export interface UpdateSportsSourceAssignmentsRequest {
  readonly followIds: readonly string[];
}

const sportsCustomSourceDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "label",
    "canonicalDomain",
    "homepageUrl",
    "feedUrl",
    "retrievalMethod",
    "enabled",
    "healthState",
    "healthReasonCode",
    "healthMessage",
    "lastCheckedAt",
    "lastSuccessAt",
    "assignedFollowIds",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    canonicalDomain: { type: "string" },
    homepageUrl: { type: "string" },
    feedUrl: { type: ["string", "null"] },
    retrievalMethod: { type: "string", enum: ["feed", "scrape"] },
    enabled: { type: "boolean" },
    healthState: {
      type: "string",
      enum: ["pending", "healthy", "failing", "unsupported", "auth_required", "disabled"]
    },
    healthReasonCode: { type: ["string", "null"] },
    healthMessage: { type: ["string", "null"] },
    lastCheckedAt: { type: ["string", "null"] },
    lastSuccessAt: { type: ["string", "null"] },
    assignedFollowIds: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" }
  }
} as const;

export const sportsCustomSourcesResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["sources"],
      properties: {
        sources: { type: "array", items: sportsCustomSourceDtoSchema }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const previewSportsSourceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 1, maxLength: 2048 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ok", "rejected", "unavailable"] },
        confirmationId: { type: "string" },
        candidate: {
          type: "object",
          additionalProperties: false,
          required: ["label", "canonicalDomain", "homepageUrl", "retrievalMethod", "sampleCount"],
          properties: {
            label: { type: "string" },
            canonicalDomain: { type: "string" },
            homepageUrl: { type: "string" },
            retrievalMethod: { type: "string", enum: ["feed", "scrape"] },
            sampleCount: { type: "number" }
          }
        },
        reason: { type: "string" },
        duplicateOfSourceId: { type: "string", format: "uuid" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const confirmSportsSourceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["confirmationId"],
    properties: {
      confirmationId: { type: "string", minLength: 1, maxLength: 256 },
      followIds: { type: "array", items: { type: "string", format: "uuid" } }
    }
  },
  response: {
    201: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: sportsCustomSourceDtoSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const deleteSportsCustomSourceSchema = {
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
      required: ["deleted"],
      properties: {
        deleted: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const updateSportsSourceAssignmentsSchema = {
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
    required: ["followIds"],
    properties: {
      followIds: { type: "array", items: { type: "string", format: "uuid" } }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: sportsCustomSourceDtoSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
