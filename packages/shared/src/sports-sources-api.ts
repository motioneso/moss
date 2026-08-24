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

export type SportsSourceRecipeStatus = "feed" | "ready" | "missing" | "drift";
export type SportsSourceTargetPreviewStatus = "pending" | "verified" | "recipe_missing";

export interface SportsSourceAssignmentDto {
  readonly id: string;
  readonly followId: string;
  readonly targetUrl: string | null;
  readonly previewStatus: SportsSourceTargetPreviewStatus;
  readonly healthState: SportsSourceHealthState;
  readonly healthReasonCode: string | null;
  readonly healthMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly createdAt: string;
}

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
  readonly recipeStatus: SportsSourceRecipeStatus;
  readonly assignedFollowIds: readonly string[];
  readonly assignments: readonly SportsSourceAssignmentDto[];
  readonly createdAt: string;
}

export interface SportsCustomSourcesResponse {
  readonly sources: readonly SportsCustomSourceDto[];
}

export interface PreviewSportsSourceRequest {
  readonly url: string;
  readonly assignments?: readonly {
    readonly followId: string;
    readonly exactTargetUrl?: string;
  }[];
}

export const SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT =
  "I confirm I am authorized to fetch this publisher's public, unauthenticated sports news.";

export interface PreviewSportsSourceTarget {
  readonly followId: string;
  readonly competitionKey: string;
  readonly competitionLabel: string;
  readonly teamKey: string | null;
  readonly teamLabel: string | null;
  readonly scope: "team" | "competition";
  readonly targetUrl: string;
  readonly sampleHeadlines: readonly string[];
}

export interface PreviewSportsSourceCandidate {
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly retrievalMethod: "feed" | "scrape";
  readonly sampleCount: number;
  readonly confirmedFetchHosts: readonly string[];
  readonly sampleHeadlines: readonly string[];
  readonly targets: readonly PreviewSportsSourceTarget[];
}

export interface PreviewSportsSourceResponse {
  readonly status: "ok" | "rejected" | "unavailable";
  readonly confirmationId?: string;
  readonly candidate?: PreviewSportsSourceCandidate;
  readonly reason?: string;
  readonly duplicateOfSourceId?: string;
  readonly authorizationAcknowledgement?: string;
}

export interface ConfirmSportsSourceRequest {
  readonly confirmationId: string;
  readonly authorizationAcknowledgement: string;
  readonly canonicalDomain: string;
  readonly confirmedFetchHosts: readonly string[];
  readonly targets: readonly {
    readonly followId: string;
    readonly targetUrl: string;
  }[];
}

export interface ConfirmSportsSourceResponse {
  readonly source: SportsCustomSourceDto;
}

export interface PreviewSportsSourceAssignmentsRequest {
  readonly assignments: readonly {
    readonly followId: string;
    readonly exactTargetUrl?: string;
  }[];
}

export type PreviewSportsSourceAssignmentsResponse = PreviewSportsSourceResponse;
export type ConfirmSportsSourceAssignmentsRequest = ConfirmSportsSourceRequest;
export type PreviewSportsSourceRecipeResponse = PreviewSportsSourceResponse;
export type ConfirmSportsSourceRecipeRequest = ConfirmSportsSourceRequest;

const sportsSourceHealthSchema = {
  type: "string",
  enum: ["pending", "healthy", "failing", "unsupported", "auth_required", "disabled"]
} as const;

const sportsSourceAssignmentDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "followId",
    "targetUrl",
    "previewStatus",
    "healthState",
    "healthReasonCode",
    "healthMessage",
    "lastCheckedAt",
    "lastSuccessAt",
    "createdAt"
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    followId: { type: "string", format: "uuid" },
    targetUrl: { type: ["string", "null"], maxLength: 2048, pattern: "^https://" },
    previewStatus: { type: "string", enum: ["pending", "verified", "recipe_missing"] },
    healthState: sportsSourceHealthSchema,
    healthReasonCode: { type: ["string", "null"], maxLength: 64 },
    healthMessage: { type: ["string", "null"], maxLength: 500 },
    lastCheckedAt: { type: ["string", "null"], format: "date-time" },
    lastSuccessAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" }
  }
} as const;

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
    "recipeStatus",
    "assignedFollowIds",
    "assignments",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string", minLength: 1, maxLength: 120 },
    canonicalDomain: { type: "string", minLength: 1, maxLength: 253 },
    homepageUrl: { type: "string", maxLength: 2048, pattern: "^https://" },
    feedUrl: { type: ["string", "null"], maxLength: 2048, pattern: "^https://" },
    retrievalMethod: { type: "string", enum: ["feed", "scrape"] },
    enabled: { type: "boolean" },
    healthState: sportsSourceHealthSchema,
    healthReasonCode: { type: ["string", "null"], maxLength: 64 },
    healthMessage: { type: ["string", "null"], maxLength: 500 },
    lastCheckedAt: { type: ["string", "null"], format: "date-time" },
    lastSuccessAt: { type: ["string", "null"], format: "date-time" },
    recipeStatus: { type: "string", enum: ["feed", "ready", "missing", "drift"] },
    assignedFollowIds: {
      type: "array",
      maxItems: 20,
      items: { type: "string", format: "uuid" }
    },
    assignments: { type: "array", maxItems: 20, items: sportsSourceAssignmentDtoSchema },
    createdAt: { type: "string", format: "date-time" }
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
      url: { type: "string", minLength: 1, maxLength: 2048 },
      assignments: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["followId"],
          properties: {
            followId: { type: "string", format: "uuid" },
            exactTargetUrl: {
              type: "string",
              maxLength: 2048,
              pattern: "^https://"
            }
          }
        }
      }
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
          required: [
            "label",
            "canonicalDomain",
            "homepageUrl",
            "retrievalMethod",
            "sampleCount",
            "confirmedFetchHosts",
            "sampleHeadlines",
            "targets"
          ],
          properties: {
            label: { type: "string" },
            canonicalDomain: { type: "string" },
            homepageUrl: { type: "string" },
            retrievalMethod: { type: "string", enum: ["feed", "scrape"] },
            sampleCount: { type: "number" },
            confirmedFetchHosts: {
              type: "array",
              maxItems: 6,
              items: { type: "string", minLength: 1, maxLength: 253 }
            },
            sampleHeadlines: {
              type: "array",
              maxItems: 10,
              items: { type: "string", minLength: 1, maxLength: 500 }
            },
            targets: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "followId",
                  "competitionKey",
                  "competitionLabel",
                  "teamKey",
                  "teamLabel",
                  "scope",
                  "targetUrl",
                  "sampleHeadlines"
                ],
                properties: {
                  followId: { type: "string", format: "uuid" },
                  competitionKey: { type: "string", minLength: 1, maxLength: 100 },
                  competitionLabel: { type: "string", minLength: 1, maxLength: 120 },
                  teamKey: { type: ["string", "null"], maxLength: 100 },
                  teamLabel: { type: ["string", "null"], maxLength: 120 },
                  scope: { type: "string", enum: ["team", "competition"] },
                  targetUrl: { type: "string", maxLength: 2048, pattern: "^https://" },
                  sampleHeadlines: {
                    type: "array",
                    maxItems: 10,
                    items: { type: "string", minLength: 1, maxLength: 500 }
                  }
                }
              }
            }
          }
        },
        reason: { type: "string" },
        duplicateOfSourceId: { type: "string", format: "uuid" },
        authorizationAcknowledgement: { type: "string", minLength: 1, maxLength: 300 }
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
    required: [
      "confirmationId",
      "authorizationAcknowledgement",
      "canonicalDomain",
      "confirmedFetchHosts",
      "targets"
    ],
    properties: {
      confirmationId: { type: "string", minLength: 1, maxLength: 256 },
      authorizationAcknowledgement: { type: "string", minLength: 1, maxLength: 300 },
      canonicalDomain: { type: "string", minLength: 1, maxLength: 253 },
      confirmedFetchHosts: {
        type: "array",
        maxItems: 6,
        items: { type: "string", minLength: 1, maxLength: 253 }
      },
      targets: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["followId", "targetUrl"],
          properties: {
            followId: { type: "string", format: "uuid" },
            targetUrl: { type: "string", maxLength: 2048, pattern: "^https://" }
          }
        }
      }
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

const sportsSourceAssignmentsParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", format: "uuid" }
  }
} as const;

export const previewSportsSourceAssignmentsSchema = {
  params: sportsSourceAssignmentsParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["assignments"],
    properties: {
      assignments: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["followId"],
          properties: {
            followId: { type: "string", format: "uuid" },
            exactTargetUrl: { type: "string", maxLength: 2048, pattern: "^https://" }
          }
        }
      }
    }
  },
  response: previewSportsSourceSchema.response
} as const;

export const updateSportsSourceAssignmentsSchema = {
  params: sportsSourceAssignmentsParamsSchema,
  body: confirmSportsSourceSchema.body,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: sportsCustomSourceDtoSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const retrySportsSourceSchema = {
  params: sportsSourceAssignmentsParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: sportsCustomSourceDtoSchema }
    },
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const previewSportsSourceRecipeSchema = {
  params: sportsSourceAssignmentsParamsSchema,
  response: previewSportsSourceSchema.response
} as const;

export const updateSportsSourceRecipeSchema = {
  params: sportsSourceAssignmentsParamsSchema,
  body: confirmSportsSourceSchema.body,
  response: updateSportsSourceAssignmentsSchema.response
} as const;
