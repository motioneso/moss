// Day-plan storage and saved-read contract. Browser-safe types and JSON schemas.
// Reads separate recorded placement from proposals;
// draft saves only change proposals. Later application work owns actual placement.
import { errorResponseSchema, nullableStringSchema } from "./schema-fragments.js";
import {
  applyConfirmationRequiredSchema,
  applyExecutionItemReportSchema,
  applyExecutionReportSchema,
  uuidSchema
} from "./day-plan-changes-api.js";
import {
  briefingRunStatusSchema,
  briefingTypeSchema,
  type BriefingRunStatus,
  type BriefingType
} from "./briefings-api.js";

export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const DAY_PLAN_BLOCK_KINDS = [
  "focus",
  "meeting",
  "prep",
  "break",
  "personal",
  "unscheduled"
] as const;
export type DayPlanBlockKind = (typeof DAY_PLAN_BLOCK_KINDS)[number];

export const DAY_PLAN_PENDING_KINDS = ["add", "move", "remove"] as const;
export type DayPlanPendingKind = (typeof DAY_PLAN_PENDING_KINDS)[number];

export const DAY_PLAN_INTENT_CAPACITIES = ["light", "normal", "full"] as const;
export type DayPlanIntentCapacity = (typeof DAY_PLAN_INTENT_CAPACITIES)[number];

export const DAY_PLAN_CORRECTION_SOURCES = ["briefing", "planner", "actor"] as const;
export type DayPlanCorrectionSource = (typeof DAY_PLAN_CORRECTION_SOURCES)[number];

export const DAY_PLAN_COMMITMENT_DECISIONS = ["commit", "defer", "drop"] as const;
export type DayPlanCommitmentDecision = (typeof DAY_PLAN_COMMITMENT_DECISIONS)[number];

export const DAY_PLAN_OPERATION_KINDS = ["add", "move", "remove"] as const;
export type DayPlanOperationKind = (typeof DAY_PLAN_OPERATION_KINDS)[number];

export const DAY_PLAN_OPERATION_OUTCOMES = ["pending", "applied", "failed", "unknown"] as const;
export type DayPlanOperationOutcome = (typeof DAY_PLAN_OPERATION_OUTCOMES)[number];

export interface DayPlanActualPlacement {
  startsAt: string | null;
  durationMinutes: number | null;
  calendarEventRef: string | null;
}

export interface DayPlanPendingAdd {
  kind: "add";
  startsAt: string;
  durationMinutes: number;
}

export interface DayPlanPendingMove {
  kind: "move";
  startsAt: string;
  durationMinutes: number;
}

export interface DayPlanPendingRemove {
  kind: "remove";
}

export type DayPlanPendingChange = DayPlanPendingAdd | DayPlanPendingMove | DayPlanPendingRemove;

export interface DayPlanIntentCorrection {
  taskId: string | null;
  note: string;
  source: DayPlanCorrectionSource;
}

export interface DayPlanOpenCommitment {
  taskId: string;
  decision: DayPlanCommitmentDecision;
}

export interface DayPlanEveningIntent {
  priorityTaskIds: string[];
  capacity: DayPlanIntentCapacity | null;
  notes: string | null;
  corrections: DayPlanIntentCorrection[];
  commitments: DayPlanOpenCommitment[];
}

export interface DayPlanBlockInput {
  id?: string;
  kind: DayPlanBlockKind;
  taskId: string | null;
  title: string | null;
  position?: number;
  // Actual placement is read back from storage only. Draft saves accept and
  // store the pending proposal; the recorded placement stays untouched until
  // later application work changes it.
  pendingChange?: DayPlanPendingChange | null;
  // Present on reads, never accepted on writes. Any value here is rejected so
  // a draft can never overwrite recorded placement.
  actualPlacement?: never;
}

export interface DayPlanSaveInput {
  localDay: string;
  timeZone: string;
  expectedRevision: number;
  // Omitted blocks means unchanged; an explicit [] clears draft blocks.
  blocks?: DayPlanBlockInput[];
  eveningIntent?: Partial<DayPlanEveningIntent> | null;
}

export interface DayPlanCreateInput {
  localDay: string;
  timeZone: string;
  sourceRunId?: string | null;
  eveningIntent?: Partial<DayPlanEveningIntent> | null;
}

export interface DayPlanBlockDto {
  id: string;
  kind: DayPlanBlockKind;
  taskId: string | null;
  title: string | null;
  position: number;
  actualPlacement: DayPlanActualPlacement | null;
  pendingChange: DayPlanPendingChange | null;
}

export interface DayPlanDto {
  id: string;
  localDay: string;
  timeZone: string;
  revision: number;
  sourceRunId: string | null;
  blocks: DayPlanBlockDto[];
  eveningIntent: DayPlanEveningIntent | null;
}

export interface GetDayPlanQuery {
  date: string;
  timeZone?: string;
}

/** A task referenced by the plan, projected from the current actor-visible record. */
export interface DayPlanTaskSummary {
  id: string;
  title: string;
  status: DayPlanTaskSummaryStatus;
  dueAt: string | null;
  doAt: string | null;
  effort: DayPlanTaskSummaryEffort | null;
}

export type DayPlanTaskSummaryStatus = "todo" | "suggested" | "done" | "archived";

export type DayPlanTaskSummaryEffort = "quick" | "medium" | "large";

/** Bounded origin-run reference for the plan's source run. */
export interface DayPlanSourceRunSummary {
  id: string;
  briefingType: BriefingType;
  status: BriefingRunStatus;
  createdAt: string;
}

/** Stored draft snapshot plus current actor-visible task facts and source-run reference. */
export interface GetDayPlanResponse {
  plan: DayPlanDto | null;
  tasks: DayPlanTaskSummary[];
  unavailableTaskIds: string[];
  sourceRun: DayPlanSourceRunSummary | null;
  sourceRunUnavailable: boolean;
}

export const dayPlanDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "localDay", "timeZone", "revision", "sourceRunId", "blocks", "eveningIntent"],
  properties: {
    id: { type: "string" },
    localDay: { type: "string" },
    timeZone: { type: "string" },
    revision: { type: "integer" },
    sourceRunId: nullableStringSchema,
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "taskId", "title", "position", "actualPlacement", "pendingChange"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: DAY_PLAN_BLOCK_KINDS },
          taskId: nullableStringSchema,
          title: nullableStringSchema,
          position: { type: "integer" },
          actualPlacement: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["startsAt", "durationMinutes", "calendarEventRef"],
            properties: {
              startsAt: nullableStringSchema,
              durationMinutes: { type: ["number", "null"] },
              calendarEventRef: nullableStringSchema
            }
          },
          pendingChange: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { type: "string", const: "remove" } }
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "startsAt", "durationMinutes"],
                properties: {
                  kind: { type: "string", enum: ["add", "move"] },
                  startsAt: { type: "string" },
                  durationMinutes: { type: "number" }
                }
              }
            ]
          }
        }
      }
    },
    eveningIntent: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["priorityTaskIds", "capacity", "notes", "corrections", "commitments"],
      properties: {
        priorityTaskIds: { type: "array", items: { type: "string" } },
        capacity: { enum: [...DAY_PLAN_INTENT_CAPACITIES, null] },
        notes: nullableStringSchema,
        corrections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["taskId", "note", "source"],
            properties: {
              taskId: nullableStringSchema,
              note: { type: "string" },
              source: { type: "string", enum: DAY_PLAN_CORRECTION_SOURCES }
            }
          }
        },
        commitments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["taskId", "decision"],
            properties: {
              taskId: { type: "string" },
              decision: { type: "string", enum: DAY_PLAN_COMMITMENT_DECISIONS }
            }
          }
        }
      }
    }
  }
} as const;

export const dayPlanTaskSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "status", "dueAt", "doAt", "effort"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    status: { type: "string", enum: ["todo", "suggested", "done", "archived"] },
    dueAt: { type: ["string", "null"] },
    doAt: { type: ["string", "null"] },
    effort: { type: ["string", "null"], enum: ["quick", "medium", "large", null] }
  }
} as const;

export const dayPlanSourceRunSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "briefingType", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    briefingType: briefingTypeSchema,
    status: briefingRunStatusSchema,
    createdAt: { type: "string" }
  }
} as const;

export const getDayPlanResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "tasks", "unavailableTaskIds", "sourceRun", "sourceRunUnavailable"],
  properties: {
    plan: { anyOf: [dayPlanDtoSchema, { type: "null" }] },
    tasks: { type: "array", items: dayPlanTaskSummarySchema },
    unavailableTaskIds: { type: "array", items: { type: "string" } },
    sourceRun: { anyOf: [dayPlanSourceRunSummarySchema, { type: "null" }] },
    sourceRunUnavailable: { type: "boolean" }
  }
} as const;

export const getDayPlanRouteSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    required: ["date"],
    properties: {
      // PostgreSQL dates have no year zero.
      date: { type: "string", pattern: `^(?!0000)${DAY_RE.source.slice(1)}` },
      timeZone: { type: "string", minLength: 1, maxLength: 64 }
    }
  },
  response: {
    200: getDayPlanResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export interface CreateDayPlanRequest {
  date: string;
  timeZone?: string;
  sourceRunId?: string | null;
}

export interface CreateDayPlanResponse {
  plan: DayPlanDto;
}

export const createDayPlanRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["date"],
  properties: {
    // PostgreSQL dates have no year zero.
    date: { type: "string", pattern: `^(?!0000)${DAY_RE.source.slice(1)}` },
    timeZone: { type: "string", minLength: 1, maxLength: 64 },
    sourceRunId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }
  }
} as const;

export const createDayPlanResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: { plan: dayPlanDtoSchema }
} as const;

export const createDayPlanRouteSchema = {
  body: createDayPlanRequestSchema,
  response: {
    200: createDayPlanResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export interface SaveDayPlanRequest {
  date: string;
  timeZone: string;
  expectedRevision: number;
  eveningIntent?: Partial<DayPlanEveningIntent> | null;
  blocks?: Array<{
    id?: string;
    kind: DayPlanBlockKind;
    taskId: string | null;
    title: string | null;
    pendingChange?: DayPlanPendingChange | null;
  }>;
}

export interface SaveDayPlanResponse {
  plan: DayPlanDto;
}

const nullableUuidSchema = { anyOf: [uuidSchema, { type: "null" }] } as const;
const instantSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$"
} as const;

const dayPlanPendingChangeSchema = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["add", "move", "remove"] },
        startsAt: instantSchema,
        durationMinutes: { type: "integer", minimum: 5, maximum: 720 }
      },
      allOf: [
        {
          if: { properties: { kind: { const: "remove" } }, required: ["kind"] },
          then: {
            not: { anyOf: [{ required: ["startsAt"] }, { required: ["durationMinutes"] }] }
          }
        },
        {
          if: {
            properties: { kind: { enum: ["add", "move"] } },
            required: ["kind"]
          },
          then: { required: ["startsAt", "durationMinutes"] }
        }
      ]
    }
  ]
} as const;

const dayPlanDraftBlockRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "taskId", "title"],
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string", enum: DAY_PLAN_BLOCK_KINDS },
    taskId: nullableUuidSchema,
    title: nullableStringSchema,
    pendingChange: dayPlanPendingChangeSchema
  }
} as const;

const dayPlanEveningIntentPatchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    priorityTaskIds: { type: "array", items: uuidSchema },
    capacity: { enum: [...DAY_PLAN_INTENT_CAPACITIES, null] },
    notes: nullableStringSchema,
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "note", "source"],
        properties: {
          taskId: nullableUuidSchema,
          note: { type: "string" },
          source: { type: "string", enum: DAY_PLAN_CORRECTION_SOURCES }
        }
      }
    },
    commitments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "decision"],
        properties: {
          taskId: uuidSchema,
          decision: { type: "string", enum: DAY_PLAN_COMMITMENT_DECISIONS }
        }
      }
    }
  }
} as const;

export const saveDayPlanRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["date", "timeZone", "expectedRevision"],
  anyOf: [{ required: ["eveningIntent"] }, { required: ["blocks"] }],
  properties: {
    // PostgreSQL dates have no year zero.
    date: { type: "string", pattern: `^(?!0000)${DAY_RE.source.slice(1)}` },
    timeZone: { type: "string", minLength: 1, maxLength: 64 },
    expectedRevision: { type: "integer", minimum: 1 },
    eveningIntent: { anyOf: [dayPlanEveningIntentPatchSchema, { type: "null" }] },
    blocks: { type: "array", items: dayPlanDraftBlockRequestSchema }
  }
} as const;

export const saveDayPlanResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: { plan: dayPlanDtoSchema }
} as const;

export const saveDayPlanRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  body: saveDayPlanRequestSchema,
  response: {
    200: saveDayPlanResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export const DAY_PLAN_PREVIEW_CONFLICT_KINDS = ["calendar_busy", "selected_overlap"] as const;
export type DayPlanPreviewConflictKind = (typeof DAY_PLAN_PREVIEW_CONFLICT_KINDS)[number];

// "task_unavailable" covers both a missing task id and a task owned by someone else — the two
// look the same to the actor by design, so a preview never turns into an oracle for other users' tasks.
export const DAY_PLAN_PREVIEW_INELIGIBLE_REASONS = [
  "task_done",
  "task_archived",
  "task_unavailable"
] as const;
export type DayPlanPreviewIneligibleReason = (typeof DAY_PLAN_PREVIEW_INELIGIBLE_REASONS)[number];

// "stale" means every account that answered came back from cache fallback with no gaps — known
// commitments are still reported, just not confirmed live. "unavailable" means no connected
// account, a gap (auth/revoked/disabled/unsupported), or a truncated read: a conflict search
// there could miss a real commitment, so absence of a conflict is not treated as proof of a free
// slot.
export const DAY_PLAN_CALENDAR_AVAILABILITIES = ["available", "stale", "unavailable"] as const;
export type DayPlanCalendarAvailability = (typeof DAY_PLAN_CALENDAR_AVAILABILITIES)[number];

export interface PreviewDayPlanRequest {
  expectedRevision: number;
  // Selection is by block id: a block's saved pending change IS the change being previewed.
  selectedChangeBlockIds: string[];
}

export interface DayPlanPreviewTiming {
  startsAt: string;
  durationMinutes: number;
}

/** Deterministic before/after for one selected block. `after` is null for a pending removal. */
export interface DayPlanPreviewBlockDetail {
  blockId: string;
  taskId: string | null;
  changeKind: DayPlanPendingKind;
  before: DayPlanPreviewTiming | null;
  after: DayPlanPreviewTiming | null;
  eligible: boolean;
  ineligibleReason: DayPlanPreviewIneligibleReason | null;
  deadlineRisk: boolean;
}

/** The actor-visible calendar commitment behind a "calendar_busy" conflict. */
export interface DayPlanPreviewConflictCalendarEvent {
  eventKey: string;
  title: string;
  startsAt: string;
  endsAt: string;
  accountLabel: string;
}

export interface DayPlanPreviewConflict {
  blockId: string;
  kind: DayPlanPreviewConflictKind;
  // Set only for kind "selected_overlap": the other selected block it overlaps.
  withBlockId: string | null;
  detail: string;
  // Set only for kind "calendar_busy": the named commitment it overlaps.
  calendarEvent: DayPlanPreviewConflictCalendarEvent | null;
}

export interface PreviewDayPlanResponse {
  revision: number;
  calendarAvailability: DayPlanCalendarAvailability;
  // The most recent connector sync this preview's calendar facts are drawn from, or null when no
  // connected calendar account has ever synced. Present whenever calendarAvailability is "stale"
  // or "available"; always null when "unavailable".
  calendarAsOf: string | null;
  blocks: DayPlanPreviewBlockDetail[];
  eligibleBlockIds: string[];
  conflicts: DayPlanPreviewConflict[];
}

const dayPlanPreviewTimingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["startsAt", "durationMinutes"],
  properties: {
    startsAt: { type: "string" },
    durationMinutes: { type: "number" }
  }
} as const;

export const previewDayPlanRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "selectedChangeBlockIds"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    selectedChangeBlockIds: { type: "array", items: { type: "string", format: "uuid" } }
  }
} as const;

const dayPlanPreviewConflictCalendarEventSchema = {
  type: "object",
  additionalProperties: false,
  required: ["eventKey", "title", "startsAt", "endsAt", "accountLabel"],
  properties: {
    eventKey: { type: "string" },
    title: { type: "string" },
    startsAt: { type: "string" },
    endsAt: { type: "string" },
    accountLabel: { type: "string" }
  }
} as const;

export const previewDayPlanResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "revision",
    "calendarAvailability",
    "calendarAsOf",
    "blocks",
    "eligibleBlockIds",
    "conflicts"
  ],
  properties: {
    revision: { type: "integer" },
    calendarAvailability: { type: "string", enum: DAY_PLAN_CALENDAR_AVAILABILITIES },
    calendarAsOf: { type: ["string", "null"] },
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "blockId",
          "taskId",
          "changeKind",
          "before",
          "after",
          "eligible",
          "ineligibleReason",
          "deadlineRisk"
        ],
        properties: {
          blockId: { type: "string" },
          taskId: nullableStringSchema,
          changeKind: { type: "string", enum: DAY_PLAN_PENDING_KINDS },
          before: { anyOf: [dayPlanPreviewTimingSchema, { type: "null" }] },
          after: { anyOf: [dayPlanPreviewTimingSchema, { type: "null" }] },
          eligible: { type: "boolean" },
          ineligibleReason: {
            anyOf: [{ type: "string", enum: DAY_PLAN_PREVIEW_INELIGIBLE_REASONS }, { type: "null" }]
          },
          deadlineRisk: { type: "boolean" }
        }
      }
    },
    eligibleBlockIds: { type: "array", items: { type: "string" } },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["blockId", "kind", "withBlockId", "detail", "calendarEvent"],
        properties: {
          blockId: { type: "string" },
          kind: { type: "string", enum: DAY_PLAN_PREVIEW_CONFLICT_KINDS },
          withBlockId: nullableStringSchema,
          detail: { type: "string" },
          calendarEvent: {
            anyOf: [dayPlanPreviewConflictCalendarEventSchema, { type: "null" }]
          }
        }
      }
    }
  }
} as const;

export const previewDayPlanRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  body: previewDayPlanRequestSchema,
  response: {
    200: previewDayPlanResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export interface DayPlanOperationInput {
  planId: string;
  expectedRevision: number;
  kind: DayPlanOperationKind;
  idempotencyKey: string;
  operationKey?: string;
  blockId?: string | null;
}

export interface DayPlanOperationDto {
  id: string;
  planId: string;
  kind: DayPlanOperationKind;
  idempotencyKey: string;
  operationKey: string | null;
  blockId: string | null;
  expectedRevision: number;
  outcome: DayPlanOperationOutcome;
  payload: Record<string, unknown>;
}

// One entry of a resolved apply selection: the block plus the pending change
// frozen at reservation time. Removals carry no timing.
export interface DayPlanApplySelectionEntry {
  blockId: string;
  kind: "add" | "move" | "remove";
  startsAt: string | null;
  durationMinutes: number | null;
}

export interface DayPlanApplyBatchInput {
  planId: string;
  expectedRevision: number;
  idempotencyKey: string;
  operationKey?: string;
  // Explicitly reviewed block ids. Omitted or empty means every block that
  // still carries an eligible addition.
  selectedBlockIds?: string[];
}

export interface DayPlanApplyBatchItemDto {
  id: string;
  blockId: string | null;
  kind: "add" | "move" | "remove";
  pendingChange: DayPlanApplySelectionEntry;
  outcome: DayPlanOperationOutcome;
  result: ApplyItemResult | null;
}

export interface DayPlanApplyBatchDto {
  id: string;
  planId: string;
  idempotencyKey: string;
  operationKey: string | null;
  expectedRevision: number;
  outcome: DayPlanOperationOutcome;
  selection: DayPlanApplySelectionEntry[];
  items: DayPlanApplyBatchItemDto[];
}

// Stable provider identity for one reserved addition, written onto the provider
// event as private metadata and used to reconcile retries without duplicates.
export interface ApplyEventProvenance {
  actorUserId: string;
  planId: string;
  blockId: string;
  planRevision: number;
  operationId: string;
}

// Stable machine-readable reasons for per-item failure or ambiguity.
export type ApplyItemFailureReason =
  | "task-unavailable"
  | "task-ineligible"
  | "block-changed"
  | "access-denied"
  | "facts-unavailable"
  | "conflict"
  | "provider-rejected"
  | "provenance-mismatch"
  | "has-attendees"
  | "mixed-batch"
  | "unknown";

export type ApplyCalendarMirror =
  | "written"
  | "skipped-rls"
  | "skipped-error"
  | "not-checked"
  | "not-cached"
  | "evicted";

export interface ApplyItemAppliedResult {
  status: "applied";
  providerEventId: string;
  startsAt: string;
  durationMinutes: number;
  calendarMirror: ApplyCalendarMirror;
  blockMirror: "mirrored" | "mismatch-preserved";
}

// Removal outcome: the provider event is gone and the block mirror cleared.
// Timing carries the deleted event's last observed window when the pre-delete
// readback saw it, else null; the mirror reports the cache eviction.
export interface ApplyItemRemovedResult {
  status: "applied";
  removed: true;
  providerEventId: string;
  startsAt: string | null;
  durationMinutes: number | null;
  calendarMirror: ApplyItemAppliedResult["calendarMirror"];
  blockMirror: "mirrored" | "mismatch-preserved";
}

export interface ApplyItemUnresolvedResult {
  status: "failed" | "unknown";
  reason: ApplyItemFailureReason;
  providerEventId?: string;
}

export type ApplyItemResult =
  | ApplyItemAppliedResult
  | ApplyItemRemovedResult
  | ApplyItemUnresolvedResult;

export interface ApplyExecutionItemReport {
  itemId: string | null;
  blockId: string | null;
  outcome: DayPlanOperationOutcome;
  result: ApplyItemResult | null;
}

export interface ApplyExecutionReport {
  operationId: string;
  planId: string;
  status: "completed" | "denied";
  denialReason?: string;
  items: ApplyExecutionItemReport[];
}

// Durable operation status derived from stored item outcomes: pending while
// any item is still pending or unknown, completed once every item is applied
// or failed. A denied execution attempt writes nothing, so it never
// fabricates a stored terminal result.
export const DAY_PLAN_APPLY_OPERATION_STATUSES = ["pending", "completed"] as const;
export type DayPlanApplyOperationStatus = (typeof DAY_PLAN_APPLY_OPERATION_STATUSES)[number];

export interface DayPlanApplyStatusResponse {
  operationId: string;
  planId: string;
  status: DayPlanApplyOperationStatus;
  items: ApplyExecutionItemReport[];
}

export interface ApplyDayPlanRequest {
  expectedRevision: number;
  idempotencyKey: string;
  operationKey?: string | null;
  selectedBlockIds?: string[];
}

export interface RetryDayPlanApplyRequest {
  itemIds: string[];
}

export const dayPlanApplyStatusResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operationId", "planId", "status", "items"],
  properties: {
    operationId: uuidSchema,
    planId: uuidSchema,
    status: { type: "string", enum: ["pending", "completed"] },
    items: { type: "array", items: applyExecutionItemReportSchema }
  }
} as const;

export const applyDayPlanRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision", "idempotencyKey"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
    operationKey: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    selectedBlockIds: { type: "array", items: uuidSchema }
  }
} as const;

const applyDayPlanParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: uuidSchema }
} as const;

export const applyDayPlanRouteSchema = {
  params: applyDayPlanParamsSchema,
  body: applyDayPlanRequestSchema,
  response: {
    200: applyExecutionReportSchema,
    202: applyConfirmationRequiredSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export const dayPlanApplyStatusRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id", "operationId"],
    properties: { id: uuidSchema, operationId: uuidSchema }
  },
  response: {
    200: dayPlanApplyStatusResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

export const retryDayPlanApplyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["itemIds"],
  properties: {
    itemIds: { type: "array", minItems: 1, items: uuidSchema }
  }
} as const;

export const retryDayPlanApplyRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id", "operationId"],
    properties: { id: uuidSchema, operationId: uuidSchema }
  },
  body: retryDayPlanApplyRequestSchema,
  response: {
    200: applyExecutionReportSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;

// Recover has no selection: the body must be absent or empty. The route
// resumes pending and unknown additions of one operation by id.
export type RecoverDayPlanApplyRequest = Record<string, never>;

export const recoverDayPlanApplyRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {}
} as const;

export const recoverDayPlanApplyRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id", "operationId"],
    properties: { id: uuidSchema, operationId: uuidSchema }
  },
  body: recoverDayPlanApplyRequestSchema,
  response: {
    200: applyExecutionReportSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;
