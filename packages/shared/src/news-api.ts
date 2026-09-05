// packages/shared/src/news-api.ts — BROWSER-SAFE. No node:* imports.
import type { MossError } from "@moss/module-sdk/errors";

import { errorResponseSchema } from "./schema-fragments.js";
import {
  newsPublisherConnectionOfferSchema,
  type NewsPublisherConnectionOfferDto
} from "./news-credentials-api.js";

/** Cross-source topic vocabulary; each source maps topics to its own feeds (see news catalog). */
export type NewsTopicKey =
  | "world"
  | "us"
  | "politics"
  | "business"
  | "technology"
  | "science"
  | "health"
  | "culture";

export const NEWS_TOPIC_KEYS: readonly NewsTopicKey[] = [
  "world",
  "us",
  "politics",
  "business",
  "technology",
  "science",
  "health",
  "culture"
];

export interface NewsTopicOption {
  readonly topicKey: NewsTopicKey;
  readonly label: string;
}

export interface NewsCatalogSource {
  readonly sourceKey: string;
  readonly label: string;
  readonly homepageUrl: string;
  /** Enabled for users with no explicit `source` prefs. */
  readonly defaultEnabled: boolean;
  /** Topics this source has a dedicated feed for (empty = top-feed only). */
  readonly topics: readonly NewsTopicKey[];
}

export interface NewsCatalogResponse {
  readonly sources: readonly NewsCatalogSource[];
  readonly topics: readonly NewsTopicOption[];
}

export interface NewsHeadline {
  /** Stable content hash of the article URL (dedupe + React keys). */
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceLabel: string;
  /** Topic feed the item came from; null when it came from a source's top feed. */
  readonly topicKey: string | null;
  readonly topicLabel: string | null;
  /** Matched personalized topics, in compiler order (at most three). */
  readonly topicLabels?: readonly string[];
  readonly title: string;
  readonly url: string;
  readonly publishedAt: string | null; // ISO instant; null when the feed omitted/garbled it
  readonly imageUrl: string | null; // curated allow-listed HTTPS URL or authenticated same-origin path
  /** Same-origin favicon proxy path for the publisher's own domain; null when it has none. */
  readonly faviconUrl: string | null;
  readonly summary: string; // sanitized plaintext, "" when absent
  /**
   * #2018: the opaque reference the story-feedback API accepts for this story. Present only on
   * stories that came from a published snapshot, because only those have a registered target row
   * to verify against. Absent means the feedback menu does not render.
   */
  readonly feedbackRef?: string;
}

export interface NewsSourceGroup {
  readonly sourceKey: string;
  readonly sourceLabel: string;
  readonly homepageUrl: string;
  readonly headlines: readonly NewsHeadline[];
}

export interface NewsOverviewResponse {
  /** Cross-source ranked selection (weight then recency; see packages/news/src/ranking.ts). */
  readonly topStories: readonly NewsHeadline[];
  /** Full personalized rank order; absent for the curated V1 fallback. */
  readonly rankedStories?: readonly NewsHeadline[];
  /** One group per effective source, in catalog order. */
  readonly sourceGroups: readonly NewsSourceGroup[];
  /** Effective topic restriction ([] = "top" front-page mode). */
  readonly activeTopics: readonly string[];
  /** Effective source set after prefs are applied (settings deep-link copy). */
  readonly enabledSources: readonly NewsEnabledSource[];
  readonly degraded: boolean;
}

export interface NewsEnabledSource {
  readonly sourceKey: string;
  readonly label: string;
}

export type NewsPrefKind = "source" | "source_exclude" | "topic";

export interface NewsPrefDto {
  readonly id: string;
  readonly kind: NewsPrefKind;
  readonly key: string;
  readonly createdAt: string;
}

export interface NewsPrefsResponse {
  readonly prefs: readonly NewsPrefDto[];
}

export interface CreateNewsPrefRequest {
  readonly kind: NewsPrefKind;
  readonly key: string;
}

export interface CreateNewsPrefResponse {
  readonly pref: NewsPrefDto;
}

export interface DeleteNewsPrefResponse {
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// #953 News personalization (Slice 1). DTOs deliberately omit
// validation_fingerprint and every provider/model identity field — those are
// module-private revalidation markers and must never reach the browser.
// ---------------------------------------------------------------------------

export interface NewsPersonalizationAvailabilityDto {
  readonly aiConfigured: boolean;
  readonly webSearchConfigured: boolean;
  readonly customSourceByUrlEnabled: boolean;
  readonly customSourceByNameEnabled: boolean;
  readonly freeformTopicsEnabled: boolean;
}

export interface NewsCustomSourceDto {
  readonly id: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape" | "reddit";
  readonly validationStatus: "approved" | "needs_revalidation" | "rejected";
  readonly healthStatus:
    | "healthy"
    | "authentication_failed"
    | "temporarily_unavailable"
    | "unsupported"
    | "disabled";
  readonly createdAt: string;
}

export interface NewsCustomTopicDto {
  readonly id: string;
  readonly label: string;
  readonly guidance: string | null;
  readonly validationStatus: "approved" | "needs_revalidation" | "rejected";
  readonly createdAt: string;
}

export interface NewsSourceExclusionDto {
  readonly id: string;
  readonly canonicalDomain: string;
  readonly createdAt: string;
}

/** Snapshot metadata ONLY — the compiled payload never leaves the backend. */
export interface NewsSnapshotMetaDto {
  readonly compiledAt: string;
  readonly expiresAt: string;
  readonly articleCount: number;
}

export interface GetNewsPersonalizationResponse {
  readonly availability: NewsPersonalizationAvailabilityDto;
  readonly customSources: readonly NewsCustomSourceDto[];
  readonly customTopics: readonly NewsCustomTopicDto[];
  readonly sourceExclusions: readonly NewsSourceExclusionDto[];
  readonly snapshot: NewsSnapshotMetaDto | null;
  readonly refresh: NewsRefreshStateDto;
}

export interface NewsSourcePreviewRequest {
  readonly input: string;
  readonly replaceSourceId?: string;
}

export interface NewsSourcePreviewCandidate {
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly retrievalMethod: "feed" | "scrape" | "reddit";
  readonly sampleCount: number;
  readonly redirectNote?: string;
}

export interface NewsSourcePreviewResponse {
  readonly status: "ok" | "ambiguous" | "rejected" | "unavailable" | "invalid";
  readonly error?: MossError;
  readonly confirmationId?: string;
  readonly candidates?: readonly NewsSourcePreviewCandidate[];
  readonly candidateIds?: readonly string[];
  readonly reason?: string;
  readonly duplicateOfSourceId?: string;
  /**
   * #2008: present only when the preview found EXACTLY ONE candidate and that candidate's
   * homepage matched a reviewed publisher connection. Its absence is what stops News asking
   * for a key on an ambiguous or unreviewed match.
   */
  readonly connection?: NewsPublisherConnectionOfferDto;
}

export interface ConfirmNewsSourceRequest {
  readonly confirmationId: string;
  readonly candidateId?: string;
}

export interface ConfirmNewsSourceResponse {
  readonly source: NewsCustomSourceDto;
}

export interface DeleteNewsCustomSourceResponse {
  readonly deleted: boolean;
}

export interface CreateNewsTopicRequest {
  readonly label: string;
  readonly guidance?: string;
}

export interface UpdateNewsTopicRequest {
  readonly label?: string;
  readonly guidance?: string;
}

export interface CreateNewsTopicResponse {
  readonly topic: NewsCustomTopicDto;
}

export interface UpdateNewsTopicResponse {
  readonly topic: NewsCustomTopicDto;
}

export interface DeleteNewsTopicResponse {
  readonly deleted: boolean;
}

export interface NewsRefreshStateDto {
  /** What is true right now. Cleared and rewritten by every run. */
  readonly state: "idle" | "queued" | "running" | "failed";
  readonly updatedAt: string | null;
  /** The live failure category. Cleared when the next run starts and again on success. */
  readonly failureKind?: "fetch" | "ai" | "internal";
  /**
   * #2030 — history, not live status: when each event last happened, ever. A later success
   * clears `failureKind` above but must leave `lastFailureAt` / `lastFailureKind` alone, so a
   * caller can still tell a run that failed an hour ago from one that succeeded a minute ago.
   */
  readonly lastRequestedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureKind: "fetch" | "ai" | "internal" | null;
}

export interface TriggerNewsRefreshResponse {
  readonly queued: boolean;
  readonly state: NewsRefreshStateDto["state"];
}

export interface TriggerNewsRevalidationResponse {
  readonly queued: boolean;
}

export interface CreateNewsSourceExclusionRequest {
  /** Raw user input (bare domain or HTTPS URL); the backend canonicalizes it. */
  readonly source: string;
}

export interface CreateNewsSourceExclusionResponse {
  readonly exclusion: NewsSourceExclusionDto;
}

export interface DeleteNewsSourceExclusionResponse {
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// JSON schemas (Fastify serialization). additionalProperties:false means any
// emitted field NOT declared here is silently dropped by fast-json-stringify —
// keep these in exact lockstep with the interfaces above.
// ---------------------------------------------------------------------------

const newsTopicOptionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topicKey", "label"],
  properties: {
    topicKey: { type: "string" },
    label: { type: "string" }
  }
} as const;

const newsCatalogSourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceKey", "label", "homepageUrl", "defaultEnabled", "topics"],
  properties: {
    sourceKey: { type: "string" },
    label: { type: "string" },
    homepageUrl: { type: "string" },
    defaultEnabled: { type: "boolean" },
    topics: { type: "array", items: { type: "string" } }
  }
} as const;

const newsHeadlineSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "sourceKey",
    "sourceLabel",
    "topicKey",
    "topicLabel",
    "title",
    "url",
    "publishedAt",
    "imageUrl",
    "faviconUrl",
    "summary"
  ],
  properties: {
    id: { type: "string" },
    sourceKey: { type: "string" },
    sourceLabel: { type: "string" },
    topicKey: { type: ["string", "null"] },
    topicLabel: { type: ["string", "null"] },
    topicLabels: { type: "array", items: { type: "string" }, maxItems: 3 },
    title: { type: "string" },
    url: { type: "string" },
    publishedAt: { type: ["string", "null"] },
    imageUrl: { type: ["string", "null"] },
    faviconUrl: { type: ["string", "null"] },
    summary: { type: "string" },
    // #2018: optional on purpose - the non-personalized fallback has no target row to verify
    // against. This schema is additionalProperties:false, so an undeclared field is dropped at
    // the wire with no error at all.
    feedbackRef: { type: "string" }
  }
} as const;

const newsSourceGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceKey", "sourceLabel", "homepageUrl", "headlines"],
  properties: {
    sourceKey: { type: "string" },
    sourceLabel: { type: "string" },
    homepageUrl: { type: "string" },
    headlines: { type: "array", items: newsHeadlineSchema }
  }
} as const;

const newsPrefDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "key", "createdAt"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["source", "source_exclude", "topic"] },
    key: { type: "string" },
    createdAt: { type: "string" }
  }
} as const;

export const newsCatalogResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["sources", "topics"],
      properties: {
        sources: { type: "array", items: newsCatalogSourceSchema },
        topics: { type: "array", items: newsTopicOptionSchema }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const newsOverviewResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["topStories", "sourceGroups", "activeTopics", "enabledSources", "degraded"],
      properties: {
        topStories: { type: "array", items: newsHeadlineSchema },
        rankedStories: { type: "array", items: newsHeadlineSchema },
        sourceGroups: { type: "array", items: newsSourceGroupSchema },
        activeTopics: { type: "array", items: { type: "string" } },
        enabledSources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sourceKey", "label"],
            properties: {
              sourceKey: { type: "string" },
              label: { type: "string" }
            }
          }
        },
        degraded: { type: "boolean" }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const newsPrefsResponseSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["prefs"],
      properties: {
        prefs: { type: "array", items: newsPrefDtoSchema }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const createNewsPrefRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "key"],
  properties: {
    kind: { type: "string", enum: ["source", "source_exclude", "topic"] },
    key: { type: "string", minLength: 1, maxLength: 100 }
  }
} as const;

export const createNewsPrefResponseSchema = {
  body: createNewsPrefRequestSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["pref"],
      properties: {
        pref: newsPrefDtoSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const deleteNewsPrefResponseSchema = {
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
      required: ["ok"],
      properties: {
        ok: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

// --- #953 personalization schemas ------------------------------------------

const newsCustomSourceDtoSchema = {
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
    retrievalMethod: { type: "string", enum: ["feed", "scrape", "reddit"] },
    validationStatus: { type: "string", enum: ["approved", "needs_revalidation", "rejected"] },
    healthStatus: {
      type: "string",
      enum: [
        "healthy",
        "authentication_failed",
        "temporarily_unavailable",
        "unsupported",
        "disabled"
      ]
    },
    createdAt: { type: "string" }
  }
} as const;

const newsCustomTopicDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "guidance", "validationStatus", "createdAt"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    guidance: { type: ["string", "null"] },
    validationStatus: { type: "string", enum: ["approved", "needs_revalidation", "rejected"] },
    createdAt: { type: "string" }
  }
} as const;

const newsSourceExclusionDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "canonicalDomain", "createdAt"],
  properties: {
    id: { type: "string" },
    canonicalDomain: { type: "string" },
    createdAt: { type: "string" }
  }
} as const;

// The five history fields must appear in BOTH `properties` and `required`, or in neither.
// additionalProperties is false, so Fastify silently drops any field not listed here: the
// repository would return the history, the response would not, and it would read as a
// repository bug rather than a schema omission.
const newsRefreshStateDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "state",
    "updatedAt",
    "lastRequestedAt",
    "lastAttemptAt",
    "lastSuccessAt",
    "lastFailureAt",
    "lastFailureKind"
  ],
  properties: {
    state: { type: "string", enum: ["idle", "queued", "running", "failed"] },
    updatedAt: { type: ["string", "null"] },
    failureKind: { type: "string", enum: ["fetch", "ai", "internal"] },
    lastRequestedAt: { type: ["string", "null"] },
    lastAttemptAt: { type: ["string", "null"] },
    lastSuccessAt: { type: ["string", "null"] },
    lastFailureAt: { type: ["string", "null"] },
    lastFailureKind: { type: ["string", "null"], enum: ["fetch", "ai", "internal", null] }
  }
} as const;

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } }
} as const;

export const getNewsPersonalizationSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: [
        "availability",
        "customSources",
        "customTopics",
        "sourceExclusions",
        "snapshot",
        "refresh"
      ],
      properties: {
        availability: {
          type: "object",
          additionalProperties: false,
          required: [
            "aiConfigured",
            "webSearchConfigured",
            "customSourceByUrlEnabled",
            "customSourceByNameEnabled",
            "freeformTopicsEnabled"
          ],
          properties: {
            aiConfigured: { type: "boolean" },
            webSearchConfigured: { type: "boolean" },
            customSourceByUrlEnabled: { type: "boolean" },
            customSourceByNameEnabled: { type: "boolean" },
            freeformTopicsEnabled: { type: "boolean" }
          }
        },
        customSources: { type: "array", items: newsCustomSourceDtoSchema },
        customTopics: { type: "array", items: newsCustomTopicDtoSchema },
        sourceExclusions: { type: "array", items: newsSourceExclusionDtoSchema },
        // Metadata only — the compiled payload column never crosses this boundary.
        snapshot: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["compiledAt", "expiresAt", "articleCount"],
          properties: {
            compiledAt: { type: "string" },
            expiresAt: { type: "string" },
            articleCount: { type: "number" }
          }
        },
        refresh: newsRefreshStateDtoSchema
      }
    },
    401: errorResponseSchema
  }
} as const;

export const createNewsSourceExclusionSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["source"],
    properties: {
      // Raw user input; normalizePublisherDomain canonicalizes and rejects server-side.
      source: { type: "string", minLength: 1, maxLength: 2048 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["exclusion"],
      properties: {
        exclusion: newsSourceExclusionDtoSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const deleteNewsSourceExclusionSchema = {
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
      required: ["ok"],
      properties: {
        ok: { type: "boolean" }
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const previewNewsSourceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["input"],
    properties: {
      input: { type: "string", minLength: 1, maxLength: 512 },
      replaceSourceId: { type: "string", format: "uuid" }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["ok", "ambiguous", "rejected", "unavailable", "invalid"]
        },
        error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "class"],
          properties: {
            code: { type: "string" },
            class: {
              type: "string",
              enum: ["prerequisite", "transient", "validation", "permission", "bug"]
            },
            remediationRef: { type: "string" }
          }
        },
        confirmationId: { type: "string" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "canonicalDomain", "homepageUrl", "retrievalMethod", "sampleCount"],
            properties: {
              label: { type: "string" },
              canonicalDomain: { type: "string" },
              homepageUrl: { type: "string" },
              retrievalMethod: { type: "string", enum: ["feed", "scrape", "reddit"] },
              sampleCount: { type: "number" },
              redirectNote: { type: "string" }
            }
          }
        },
        candidateIds: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        duplicateOfSourceId: { type: "string", format: "uuid" },
        connection: newsPublisherConnectionOfferSchema
      }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const confirmNewsSourceSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["confirmationId"],
    properties: {
      confirmationId: { type: "string", minLength: 1, maxLength: 256 },
      candidateId: { type: "string", minLength: 1, maxLength: 256 }
    }
  },
  response: {
    201: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: { source: newsCustomSourceDtoSchema }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    409: errorResponseSchema
  }
} as const;

export const deleteNewsCustomSourceSchema = {
  params: idParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deleted"],
      properties: { deleted: { type: "boolean" } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

const newsTopicWriteResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  422: errorResponseSchema,
  503: errorResponseSchema
} as const;

export const createNewsTopicSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["label"],
    properties: {
      label: { type: "string", minLength: 1, maxLength: 80 },
      guidance: { type: "string", maxLength: 1000 }
    }
  },
  response: {
    201: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: { topic: newsCustomTopicDtoSchema }
    },
    ...newsTopicWriteResponses
  }
} as const;

export const updateNewsTopicSchema = {
  params: idParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      label: { type: "string", minLength: 1, maxLength: 80 },
      guidance: { type: "string", maxLength: 1000 }
    }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: { topic: newsCustomTopicDtoSchema }
    },
    ...newsTopicWriteResponses
  }
} as const;

export const deleteNewsTopicSchema = {
  params: idParamsSchema,
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["deleted"],
      properties: { deleted: { type: "boolean" } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const triggerNewsRefreshSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["queued", "state"],
      properties: {
        queued: { type: "boolean" },
        state: { type: "string", enum: ["idle", "queued", "running", "failed"] }
      }
    },
    401: errorResponseSchema
  }
} as const;

export const triggerNewsRevalidationSchema = {
  response: {
    202: {
      type: "object",
      additionalProperties: false,
      required: ["queued"],
      properties: { queued: { type: "boolean" } }
    },
    401: errorResponseSchema
  }
} as const;
