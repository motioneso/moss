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

/**
 * #2237 what the source row says about photos. Derived on the server from the source's photo
 * record, never stored, so the sentence a user reads cannot drift from the last refresh.
 */
export type SportsSourcePhotoStatus =
  | "working"
  | "none"
  | "previewing"
  | "stopped_working"
  | "pending";
export const SPORTS_SOURCE_PHOTO_STATUSES: readonly SportsSourcePhotoStatus[] = [
  "working",
  "none",
  "previewing",
  "stopped_working",
  "pending"
];
/** #2211: `reddit` reads a subreddit's public new-posts listing; recipe-less like `feed`. */
export type SportsSourceRetrievalMethod = "feed" | "scrape" | "reddit";
export const SPORTS_SOURCE_RETRIEVAL_METHODS: readonly SportsSourceRetrievalMethod[] = [
  "feed",
  "scrape",
  "reddit"
];
export type SportsSourceTargetPreviewStatus = "pending" | "verified" | "recipe_missing";
export const SPORTS_SOURCE_ASSIGNMENT_LIMIT = 20;

export const SPORTS_SPORT_KEYS = [
  "football",
  "hockey",
  "soccer",
  "baseball",
  "basketball"
] as const;
export type SportsSportKey = (typeof SPORTS_SPORT_KEYS)[number];

export type SportsSourceAssignmentTarget =
  | { readonly kind: "sport"; readonly sportKey: SportsSportKey }
  | { readonly kind: "follow"; readonly followId: string };

export interface SportsSourceAssignmentDto {
  readonly id: string;
  readonly followId: string | null;
  readonly sportKey: SportsSportKey | null;
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
  readonly retrievalMethod: SportsSourceRetrievalMethod;
  readonly enabled: boolean;
  readonly healthState: SportsSourceHealthState;
  readonly healthReasonCode: string | null;
  readonly healthMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly recipeStatus: SportsSourceRecipeStatus;
  /** #2237 whether stories from this source are getting photos, and what to do if not. */
  readonly photoStatus: SportsSourcePhotoStatus;
  /** #2237 true only when the photos come from a rule Moss found and the owner confirmed. */
  readonly photosFoundByMoss: boolean;
  readonly assignedFollowIds: readonly string[];
  readonly assignments: readonly SportsSourceAssignmentDto[];
  readonly createdAt: string;
}

export interface SportsBuiltinSourceDto {
  readonly kind: "builtin";
  readonly id: "espn";
  readonly label: "ESPN";
  readonly enabled: boolean;
  readonly usesDefaultCoverage: boolean;
  readonly assignments: readonly SportsSourceAssignmentTarget[];
}

export type SportsNewsSourceDto =
  | SportsBuiltinSourceDto
  | (SportsCustomSourceDto & { readonly kind: "custom" });

export interface SportsCustomSourcesResponse {
  readonly sources: readonly SportsCustomSourceDto[];
}

export interface SportsNewsSourcesResponse {
  readonly sources: readonly SportsNewsSourceDto[];
}

export interface UpdateSportsEspnCoverageRequest {
  readonly assignments: readonly SportsSourceAssignmentTarget[];
}

export interface UpdateSportsEspnCoverageResponse {
  readonly source: SportsBuiltinSourceDto;
}

export interface SportsSourceAssignmentInput {
  readonly target: SportsSourceAssignmentTarget;
  readonly exactTargetUrl?: string;
}

export interface PreviewSportsSourceRequest {
  readonly url: string;
  readonly assignments?: readonly SportsSourceAssignmentInput[];
}

export const SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT =
  "I confirm I am authorized to fetch this publisher's public, unauthenticated sports news.";

export interface PreviewSportsSourceTarget {
  readonly target: SportsSourceAssignmentTarget;
  readonly label: string;
  readonly scope: "sport" | "team" | "competition";
  readonly targetUrl: string;
  readonly sampleHeadlines: readonly string[];
}

export interface PreviewSportsSourceCandidate {
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly retrievalMethod: SportsSourceRetrievalMethod;
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
    readonly target: SportsSourceAssignmentTarget;
    readonly targetUrl: string;
  }[];
}

export interface ConfirmSportsSourceResponse {
  readonly source: SportsCustomSourceDto;
}

export interface PreviewSportsSourceAssignmentsRequest {
  readonly assignments: readonly SportsSourceAssignmentInput[];
}

export type PreviewSportsSourceAssignmentsResponse = PreviewSportsSourceResponse;
export type ConfirmSportsSourceAssignmentsRequest = ConfirmSportsSourceRequest;
export type PreviewSportsSourceRecipeResponse = PreviewSportsSourceResponse;
export type ConfirmSportsSourceRecipeRequest = ConfirmSportsSourceRequest;

const sportsSourceHealthSchema = {
  type: "string",
  enum: ["pending", "healthy", "failing", "unsupported", "auth_required", "disabled"]
} as const;

const sportsSourceAssignmentTargetSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "sportKey"],
      properties: {
        kind: { const: "sport" },
        sportKey: { type: "string", enum: SPORTS_SPORT_KEYS }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "followId"],
      properties: {
        kind: { const: "follow" },
        followId: { type: "string", format: "uuid" }
      }
    }
  ]
} as const;

const sportsSourceAssignmentInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target"],
  properties: {
    target: sportsSourceAssignmentTargetSchema,
    exactTargetUrl: { type: "string", maxLength: 2048, pattern: "^https://.+$" }
  }
} as const;

const sportsSourceAssignmentDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "followId",
    "sportKey",
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
    followId: { type: ["string", "null"], format: "uuid" },
    sportKey: { type: ["string", "null"], enum: [...SPORTS_SPORT_KEYS, null] },
    targetUrl: { type: ["string", "null"], maxLength: 2048, pattern: "^https://.+$" },
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
    "photoStatus",
    "photosFoundByMoss",
    "assignedFollowIds",
    "assignments",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string", minLength: 1, maxLength: 120 },
    canonicalDomain: { type: "string", minLength: 1, maxLength: 253 },
    homepageUrl: { type: "string", maxLength: 2048, pattern: "^https://.+$" },
    feedUrl: { type: ["string", "null"], maxLength: 2048, pattern: "^https://.+$" },
    retrievalMethod: { type: "string", enum: SPORTS_SOURCE_RETRIEVAL_METHODS },
    enabled: { type: "boolean" },
    healthState: sportsSourceHealthSchema,
    healthReasonCode: { type: ["string", "null"], maxLength: 64 },
    healthMessage: { type: ["string", "null"], maxLength: 500 },
    lastCheckedAt: { type: ["string", "null"], format: "date-time" },
    lastSuccessAt: { type: ["string", "null"], format: "date-time" },
    recipeStatus: { type: "string", enum: ["feed", "ready", "missing", "drift"] },
    photoStatus: { type: "string", enum: SPORTS_SOURCE_PHOTO_STATUSES },
    photosFoundByMoss: { type: "boolean" },
    assignedFollowIds: {
      type: "array",
      maxItems: 20,
      items: { type: "string", format: "uuid" }
    },
    assignments: { type: "array", maxItems: 20, items: sportsSourceAssignmentDtoSchema },
    createdAt: { type: "string", format: "date-time" }
  }
} as const;

const sportsNewsCustomSourceDtoSchema = {
  ...sportsCustomSourceDtoSchema,
  required: [...sportsCustomSourceDtoSchema.required, "kind"],
  properties: {
    ...sportsCustomSourceDtoSchema.properties,
    kind: { const: "custom" }
  }
} as const;

const sportsBuiltinSourceDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "label", "enabled", "usesDefaultCoverage", "assignments"],
  properties: {
    kind: { const: "builtin" },
    id: { const: "espn" },
    label: { const: "ESPN" },
    enabled: { type: "boolean" },
    usesDefaultCoverage: { type: "boolean" },
    assignments: {
      type: "array",
      maxItems: SPORTS_SOURCE_ASSIGNMENT_LIMIT,
      items: sportsSourceAssignmentTargetSchema
    }
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

export const sportsNewsSourcesResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["sources"],
      properties: {
        sources: {
          type: "array",
          items: { oneOf: [sportsBuiltinSourceDtoSchema, sportsNewsCustomSourceDtoSchema] }
        }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const updateSportsEspnCoverageSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["assignments"],
    properties: {
      assignments: {
        type: "array",
        maxItems: SPORTS_SOURCE_ASSIGNMENT_LIMIT,
        items: sportsSourceAssignmentTargetSchema
      }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: sportsBuiltinSourceDtoSchema }
    },
    400: errorResponseSchema,
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
        items: sportsSourceAssignmentInputSchema
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
            retrievalMethod: { type: "string", enum: SPORTS_SOURCE_RETRIEVAL_METHODS },
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
                required: ["target", "label", "scope", "targetUrl", "sampleHeadlines"],
                properties: {
                  target: sportsSourceAssignmentTargetSchema,
                  label: { type: "string", minLength: 1, maxLength: 120 },
                  scope: { type: "string", enum: ["sport", "team", "competition"] },
                  targetUrl: { type: "string", maxLength: 2048, pattern: "^https://.+$" },
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
          required: ["target", "targetUrl"],
          properties: {
            target: sportsSourceAssignmentTargetSchema,
            targetUrl: { type: "string", maxLength: 2048, pattern: "^https://.+$" }
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
        items: sportsSourceAssignmentInputSchema
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

/**
 * #2237 DELETE /api/sports/sources/:id/photos - "Stop using Moss's photos". Removes the saved
 * photo rule and puts the source back on the feed tag and share image pass alone.
 */
export const deleteSportsSourcePhotosSchema = {
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
