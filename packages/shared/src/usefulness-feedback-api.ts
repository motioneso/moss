import { errorResponseSchema, idParamsSchema, jsonObjectSchema } from "./schema-fragments.js";

export type UsefulnessFeedbackKind =
  | "more_like_this"
  | "less_like_this"
  | "too_much"
  | "wrong_priority"
  | "not_useful"
  | "remember_this"
  | "dismiss";

export type FeedbackTargetKind =
  | "chat_message"
  | "briefing_run"
  | "briefing_item"
  | "proactive_card"
  | "news_story"
  | "sports_story";

export type FeedbackSurface = "chat" | "briefing" | "today" | "proactive" | "news" | "sports";
export type FeedbackStatus = "active" | "undone" | "superseded";

/** Modules that own story targets; the query filter on the list route maps through this. */
export type StoryFeedbackModule = "news" | "sports";

export const STORY_FEEDBACK_REASON_MAX_LENGTH = 500;

export interface CreateUsefulnessFeedbackRequest {
  readonly targetKind: FeedbackTargetKind;
  readonly targetRef: string;
  readonly surface: FeedbackSurface;
  readonly kind: UsefulnessFeedbackKind;
  /** Required for `less_like_this` and rejected for every other action. */
  readonly reason?: string;
}

export interface UpdateUsefulnessFeedbackReasonRequest {
  readonly reason: string;
}

export interface ListUsefulnessFeedbackQuery {
  readonly module?: StoryFeedbackModule;
  readonly status?: FeedbackStatus;
}

export interface UsefulnessFeedbackDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly targetKind: FeedbackTargetKind;
  readonly targetRef: string;
  readonly surface: FeedbackSurface;
  readonly kind: UsefulnessFeedbackKind;
  readonly sourceKind: string | null;
  readonly sourceLabel: string | null;
  readonly priorityBand: string | null;
  readonly effectKind: string | null;
  readonly effectRef: string | null;
  readonly metadata: Record<string, unknown>;
  readonly status: FeedbackStatus;
  readonly reason: string | null;
  readonly revision: number;
  readonly ruleVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
}

export interface CreateUsefulnessFeedbackResponse {
  readonly feedback: UsefulnessFeedbackDto;
}

export interface ListUsefulnessFeedbackResponse {
  readonly feedback: readonly UsefulnessFeedbackDto[];
}

export const usefulnessFeedbackKindSchema = {
  type: "string",
  enum: [
    "more_like_this",
    "less_like_this",
    "too_much",
    "wrong_priority",
    "not_useful",
    "remember_this",
    "dismiss"
  ]
} as const;

export const feedbackTargetKindSchema = {
  type: "string",
  enum: [
    "chat_message",
    "briefing_run",
    "briefing_item",
    "proactive_card",
    "news_story",
    "sports_story"
  ]
} as const;

export const feedbackSurfaceSchema = {
  type: "string",
  enum: ["chat", "briefing", "today", "proactive", "news", "sports"]
} as const;

export const feedbackStatusSchema = {
  type: "string",
  enum: ["active", "undone", "superseded"]
} as const;

export const storyFeedbackModuleSchema = {
  type: "string",
  enum: ["news", "sports"]
} as const;

export const createUsefulnessFeedbackRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetKind", "targetRef", "surface", "kind"],
  properties: {
    targetKind: feedbackTargetKindSchema,
    targetRef: { type: "string", minLength: 1, maxLength: 1024 },
    surface: feedbackSurfaceSchema,
    kind: usefulnessFeedbackKindSchema,
    reason: { type: "string", minLength: 1, maxLength: STORY_FEEDBACK_REASON_MAX_LENGTH }
  }
} as const;

export const updateUsefulnessFeedbackReasonRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", minLength: 1, maxLength: STORY_FEEDBACK_REASON_MAX_LENGTH }
  }
} as const;

export const listUsefulnessFeedbackQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    module: storyFeedbackModuleSchema,
    status: feedbackStatusSchema
  }
} as const;

export const usefulnessFeedbackSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "ownerUserId",
    "targetKind",
    "targetRef",
    "surface",
    "kind",
    "sourceKind",
    "sourceLabel",
    "priorityBand",
    "effectKind",
    "effectRef",
    "metadata",
    "status",
    "reason",
    "revision",
    "ruleVersion",
    "createdAt",
    "updatedAt",
    "resolvedAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    targetKind: feedbackTargetKindSchema,
    targetRef: { type: "string" },
    surface: feedbackSurfaceSchema,
    kind: usefulnessFeedbackKindSchema,
    sourceKind: { type: ["string", "null"] },
    sourceLabel: { type: ["string", "null"] },
    priorityBand: { type: ["string", "null"] },
    effectKind: { type: ["string", "null"] },
    effectRef: { type: ["string", "null"] },
    metadata: jsonObjectSchema,
    status: feedbackStatusSchema,
    reason: { type: ["string", "null"] },
    revision: { type: "integer" },
    ruleVersion: { type: ["integer", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    resolvedAt: { type: ["string", "null"] }
  }
} as const;

export const createUsefulnessFeedbackResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feedback"],
  properties: { feedback: usefulnessFeedbackSchema }
} as const;

export const listUsefulnessFeedbackResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feedback"],
  properties: { feedback: { type: "array", items: usefulnessFeedbackSchema } }
} as const;

export const createUsefulnessFeedbackRouteSchema = {
  body: createUsefulnessFeedbackRequestSchema,
  response: {
    200: createUsefulnessFeedbackResponseSchema,
    201: createUsefulnessFeedbackResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const listUsefulnessFeedbackRouteSchema = {
  querystring: listUsefulnessFeedbackQuerySchema,
  response: {
    200: listUsefulnessFeedbackResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const updateUsefulnessFeedbackReasonRouteSchema = {
  params: idParamsSchema,
  body: updateUsefulnessFeedbackReasonRequestSchema,
  response: {
    200: createUsefulnessFeedbackResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const undoUsefulnessFeedbackRouteSchema = {
  params: idParamsSchema,
  response: {
    200: createUsefulnessFeedbackResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
