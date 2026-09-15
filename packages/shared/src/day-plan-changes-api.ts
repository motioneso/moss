// Change-confirmation contract (R2.2-T05): the bound change set, the 202 gate
// response, and the confirm route schemas. Kept out of day-plan-api.ts so
// that file stays under its size limit.
import { errorResponseSchema } from "./schema-fragments.js";

export const uuidSchema = { type: "string", format: "uuid" } as const;

// Per-item result: Fastify serializes responses from this schema, so every
// field the execution service returns must be listed here. A bare object
// schema drops all fields and the HTTP boundary returns result as {}.
export const applyItemResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["applied", "failed", "unknown"] },
    reason: {
      type: "string",
      enum: [
        "task-unavailable",
        "task-ineligible",
        "block-changed",
        "access-denied",
        "facts-unavailable",
        "conflict",
        "provider-rejected",
        "provenance-mismatch",
        "has-attendees",
        "mixed-batch",
        "unknown"
      ]
    },
    providerEventId: { anyOf: [{ type: "string" }, { type: "null" }] },
    startsAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    durationMinutes: { anyOf: [{ type: "number" }, { type: "null" }] },
    calendarMirror: {
      type: "string",
      enum: ["written", "skipped-rls", "skipped-error", "not-checked", "not-cached", "evicted"]
    },
    blockMirror: { type: "string", enum: ["mirrored", "mismatch-preserved"] },
    removed: { type: "boolean" }
  }
} as const;

export const applyExecutionItemReportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["itemId", "blockId", "outcome", "result"],
  properties: {
    itemId: { anyOf: [uuidSchema, { type: "null" }] },
    blockId: { anyOf: [uuidSchema, { type: "null" }] },
    outcome: { type: "string", enum: ["pending", "applied", "failed", "unknown"] },
    result: { anyOf: [applyItemResultSchema, { type: "null" }] }
  }
} as const;

export const applyExecutionReportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operationId", "planId", "status", "items"],
  properties: {
    operationId: uuidSchema,
    planId: uuidSchema,
    status: { type: "string", enum: ["completed", "denied"] },
    denialReason: { type: "string" },
    items: { type: "array", items: applyExecutionItemReportSchema }
  }
} as const;

// One frozen change of a reserved batch: the block, its kind, the stored
// provider reference (null for not-yet-created additions), and the target
// window (null timing for removals). The approval binds exactly this list.
export interface DayPlanChangeSetEntry {
  blockId: string;
  kind: "add" | "move" | "remove";
  calendarEventRef: string | null;
  startsAt: string | null;
  durationMinutes: number | null;
}

// Returned with 202 when a reserved batch holds a move or removal and the
// actor's calendar_management tier requires confirmation: nothing executed,
// zero provider calls, no item outcome written.
export interface ApplyConfirmationRequiredResponse {
  status: "confirmation-required";
  operationId: string;
  approvalId: string;
  changes: DayPlanChangeSetEntry[];
}

const dayPlanChangeSetEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["blockId", "kind", "calendarEventRef", "startsAt", "durationMinutes"],
  properties: {
    blockId: uuidSchema,
    kind: { type: "string", enum: ["add", "move", "remove"] },
    calendarEventRef: { anyOf: [{ type: "string" }, { type: "null" }] },
    startsAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    durationMinutes: { anyOf: [{ type: "number" }, { type: "null" }] }
  }
} as const;

export const applyConfirmationRequiredSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "operationId", "approvalId", "changes"],
  properties: {
    status: { type: "string", enum: ["confirmation-required"] },
    operationId: uuidSchema,
    approvalId: uuidSchema,
    changes: { type: "array", items: dayPlanChangeSetEntrySchema }
  }
} as const;

// Confirm carries the pending approval id; the route executes only when the
// approval is owned by the actor, still pending, and bound to this exact
// operation, revision and change set. Anything else is a 409 with no writes.
export interface ConfirmDayPlanApplyRequest {
  approvalId: string;
}

export const confirmDayPlanApplyRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approvalId"],
  properties: {
    approvalId: uuidSchema
  }
} as const;

export const confirmDayPlanApplyRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id", "operationId"],
    properties: { id: uuidSchema, operationId: uuidSchema }
  },
  body: confirmDayPlanApplyRequestSchema,
  response: {
    200: applyExecutionReportSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;
