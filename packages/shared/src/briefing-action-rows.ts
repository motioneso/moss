// Type-only: a value import here would close a module cycle
// (briefings-api -> briefing-action-rows -> day-plan-api -> briefings-api).
// The schema literals below mirror the day-plan-api vocabularies by hand.
import type {
  DayPlanActualPlacement,
  DayPlanBlockKind,
  DayPlanCommitmentDecision,
  DayPlanCorrectionSource,
  DayPlanIntentCapacity,
  DayPlanPendingKind
} from "./day-plan-api.js";

const PLAN_BLOCK_KINDS = ["focus", "meeting", "prep", "break", "personal", "unscheduled"] as const;
const PLAN_PENDING_KINDS = ["add", "move", "remove"] as const;
const PLAN_INTENT_CAPACITIES = ["light", "normal", "full"] as const;
const PLAN_CORRECTION_SOURCES = ["briefing", "planner", "actor"] as const;
const PLAN_COMMITMENT_DECISIONS = ["commit", "defer", "drop"] as const;

export type BriefingActionCategory = "needs_reply" | "needs_action" | "time_sensitive_info";

export type BriefingActionPrimaryAction =
  | { readonly kind: "reply"; readonly cacheMessageId: string }
  | { readonly kind: "view"; readonly href: string };

export type BriefingActionResurfaceReason = "due_tomorrow" | "relevant_context";

export interface TaskSuggestionMetadataV1 {
  readonly version: 1;
  readonly category: BriefingActionCategory;
  readonly sourceLabel: string;
  readonly sourceHref: string | null;
  readonly cacheMessageId: string | null;
  readonly subjectSignature: string;
  readonly computedAt: string;
  readonly resurfaceReason: BriefingActionResurfaceReason | null;
}

export interface BriefingActionRowDto {
  readonly taskId: string;
  readonly title: string;
  readonly explanation: string;
  readonly category: BriefingActionCategory;
  readonly status: "suggested" | "accepted" | "dismissed";
  readonly primaryAction: BriefingActionPrimaryAction | null;
  readonly source: string;
  readonly sourceLabel: string;
  readonly sourceRef: string;
  readonly sourceHref: string | null;
  readonly dueAt: string | null;
  readonly computedAt: string;
  readonly resurfaceReason: BriefingActionResurfaceReason | null;
}

export interface BriefingCatchUpDto {
  readonly source: "email";
  readonly itemCount: number;
  readonly summaryText: string;
  readonly asOf: string | null;
}

export interface BriefingPlanBlockV1 {
  readonly id: string;
  readonly kind: DayPlanBlockKind;
  readonly taskId: string | null;
  readonly title: string | null;
  readonly position: number;
  readonly actualPlacement: DayPlanActualPlacement | null;
  readonly pendingChange: DayPlanPendingKind | null;
  /** Proposed time for a pending add or move; absent when the proposal has none. */
  readonly pendingStartsAt?: string | null;
  readonly pendingDurationMinutes?: number | null;
}

export interface BriefingPlanIntentCorrectionV1 {
  readonly taskId: string | null;
  readonly note: string;
  readonly source: DayPlanCorrectionSource;
}

export interface BriefingPlanCommitmentV1 {
  readonly taskId: string;
  readonly decision: DayPlanCommitmentDecision;
}

export interface BriefingPlanEveningIntentV1 {
  readonly priorityTaskIds: readonly string[];
  readonly capacity: DayPlanIntentCapacity | null;
  readonly notes: string | null;
  readonly corrections: readonly BriefingPlanIntentCorrectionV1[];
  readonly commitments: readonly BriefingPlanCommitmentV1[];
}

export interface BriefingPlanContextV1 {
  readonly version: 1;
  readonly planId: string;
  readonly revision: number;
  readonly localDay: string;
  readonly timeZone: string;
  readonly sourceRunId: string | null;
  readonly eveningIntent: BriefingPlanEveningIntentV1 | null;
  readonly blocks: readonly BriefingPlanBlockV1[];
}

export interface BriefingStructuredPayloadV1 {
  readonly version: 1;
  readonly actionRows: readonly BriefingActionRowDto[];
  readonly catchUp: BriefingCatchUpDto | null;
  readonly planContext?: BriefingPlanContextV1 | null;
}

/**
 * Pure reader for the saved-plan context on a run payload. Returns null when
 * the field is missing (runs written before T12) or the version is not 1.
 */
export function readPlanContext(
  payload: BriefingStructuredPayloadV1 | Record<string, unknown> | null | undefined
): BriefingPlanContextV1 | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const candidate = (payload as { readonly planContext?: unknown }).planContext;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const context = candidate as Record<string, unknown>;
  if (context.version !== 1) return null;
  if (typeof context.planId !== "string") return null;
  if (typeof context.revision !== "number") return null;
  if (!Array.isArray(context.blocks)) return null;
  return candidate as BriefingPlanContextV1;
}

const actionCategorySchema = {
  type: "string",
  enum: ["needs_reply", "needs_action", "time_sensitive_info"]
} as const;

const resurfaceReasonSchema = {
  type: ["string", "null"],
  enum: ["due_tomorrow", "relevant_context", null]
} as const;

const primaryActionSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "cacheMessageId"],
      properties: { kind: { type: "string", enum: ["reply"] }, cacheMessageId: { type: "string" } }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "href"],
      properties: { kind: { type: "string", enum: ["view"] }, href: { type: "string" } }
    },
    { type: "null" }
  ]
} as const;

export const taskSuggestionMetadataV1Schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "category",
    "sourceLabel",
    "sourceHref",
    "cacheMessageId",
    "subjectSignature",
    "computedAt",
    "resurfaceReason"
  ],
  properties: {
    version: { type: "integer", enum: [1] },
    category: actionCategorySchema,
    sourceLabel: { type: "string" },
    sourceHref: { type: ["string", "null"] },
    cacheMessageId: { type: ["string", "null"] },
    subjectSignature: { type: "string" },
    computedAt: { type: "string" },
    resurfaceReason: resurfaceReasonSchema
  }
} as const;

export const briefingActionRowDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "taskId",
    "title",
    "explanation",
    "category",
    "status",
    "primaryAction",
    "source",
    "sourceLabel",
    "sourceRef",
    "sourceHref",
    "dueAt",
    "computedAt",
    "resurfaceReason"
  ],
  properties: {
    taskId: { type: "string" },
    title: { type: "string" },
    explanation: { type: "string" },
    category: actionCategorySchema,
    status: { type: "string", enum: ["suggested", "accepted", "dismissed"] },
    primaryAction: primaryActionSchema,
    source: { type: "string" },
    sourceLabel: { type: "string" },
    sourceRef: { type: "string" },
    sourceHref: { type: ["string", "null"] },
    dueAt: { type: ["string", "null"] },
    computedAt: { type: "string" },
    resurfaceReason: resurfaceReasonSchema
  }
} as const;

export const briefingCatchUpDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "itemCount", "summaryText", "asOf"],
  properties: {
    source: { type: "string", enum: ["email"] },
    itemCount: { type: "integer", minimum: 0 },
    summaryText: { type: "string" },
    asOf: { type: ["string", "null"] }
  }
} as const;

const briefingPlanBlockV1Schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "taskId", "title", "position", "actualPlacement", "pendingChange"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: [...PLAN_BLOCK_KINDS] },
    taskId: { type: ["string", "null"] },
    title: { type: ["string", "null"], maxLength: 120 },
    position: { type: "integer", minimum: 0 },
    actualPlacement: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["startsAt", "durationMinutes", "calendarEventRef"],
          properties: {
            startsAt: { type: ["string", "null"] },
            durationMinutes: { type: ["integer", "null"], minimum: 1 },
            calendarEventRef: { type: ["string", "null"] }
          }
        },
        { type: "null" }
      ]
    },
    pendingChange: { type: ["string", "null"], enum: [...PLAN_PENDING_KINDS, null] },
    pendingStartsAt: { type: ["string", "null"] },
    pendingDurationMinutes: { type: ["integer", "null"], minimum: 1 }
  }
} as const;

const briefingPlanEveningIntentV1Schema = {
  type: "object",
  additionalProperties: false,
  required: ["priorityTaskIds", "capacity", "notes", "corrections", "commitments"],
  properties: {
    priorityTaskIds: { type: "array", items: { type: "string" }, maxItems: 8 },
    capacity: { type: ["string", "null"], enum: [...PLAN_INTENT_CAPACITIES, null] },
    notes: { type: ["string", "null"], maxLength: 400 },
    corrections: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "note", "source"],
        properties: {
          taskId: { type: ["string", "null"] },
          note: { type: "string", maxLength: 200 },
          source: { type: "string", enum: [...PLAN_CORRECTION_SOURCES] }
        }
      }
    },
    commitments: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "decision"],
        properties: {
          taskId: { type: "string" },
          decision: { type: "string", enum: [...PLAN_COMMITMENT_DECISIONS] }
        }
      }
    }
  }
} as const;

export const briefingPlanContextV1Schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "planId",
    "revision",
    "localDay",
    "timeZone",
    "sourceRunId",
    "eveningIntent",
    "blocks"
  ],
  properties: {
    version: { type: "integer", enum: [1] },
    planId: { type: "string" },
    revision: { type: "integer", minimum: 1 },
    localDay: { type: "string" },
    timeZone: { type: "string" },
    sourceRunId: { type: ["string", "null"] },
    eveningIntent: { anyOf: [briefingPlanEveningIntentV1Schema, { type: "null" }] },
    blocks: { type: "array", items: briefingPlanBlockV1Schema, maxItems: 24 }
  }
} as const;

export const briefingStructuredPayloadV1Schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "actionRows", "catchUp"],
  properties: {
    version: { type: "integer", enum: [1] },
    actionRows: { type: "array", items: briefingActionRowDtoSchema },
    catchUp: { anyOf: [briefingCatchUpDtoSchema, { type: "null" }] },
    planContext: { anyOf: [briefingPlanContextV1Schema, { type: "null" }] }
  }
} as const;
