// Day-plan storage and saved-read contract. Browser-safe types and JSON schemas.
// Reads separate recorded placement from proposals;
// draft saves only change proposals. Later application work owns actual placement.
import { errorResponseSchema, nullableStringSchema } from "./schema-fragments.js";

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

/** Stored draft snapshot; task labels and references are not current source validation. */
export interface GetDayPlanResponse {
  plan: DayPlanDto | null;
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

export const getDayPlanResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: { plan: { anyOf: [dayPlanDtoSchema, { type: "null" }] } }
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

const uuidSchema = { type: "string", format: "uuid" } as const;
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
