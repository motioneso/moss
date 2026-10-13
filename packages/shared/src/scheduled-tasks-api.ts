import type { ApprovedActionScopeDto } from "./responsibility-agreement.js";
import { errorResponseSchema } from "./schema-fragments.js";

export type ScheduledTaskState =
  | "active"
  | "paused"
  | "completed"
  | "expired"
  | "failed"
  | "cancelled";

export interface ScheduledTaskMessageDto {
  readonly scheduledReadSource?: "tasks";
  readonly id: string;
  readonly threadId: string;
  readonly body: string;
}

export interface ScheduledTaskRunDto {
  readonly at: string;
  readonly outcome: "delivered" | "expired";
  readonly summary: string;
  readonly message: ScheduledTaskMessageDto | null;
}

export interface ScheduledTaskDto {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  readonly group: "Reminders" | "Daily" | "Weekly" | "More often";
  readonly schedule?: string | null;
  readonly timeZone?: string | null;
  readonly state: ScheduledTaskState;
  readonly dueAt: string;
  readonly deadlineAt: string | null;
  readonly createdAt: string;
  readonly runs: readonly ScheduledTaskRunDto[];
}

export interface ListScheduledTasksResponse {
  readonly approvedScopes?: readonly ApprovedActionScopeDto[];
  readonly tasks: readonly ScheduledTaskDto[];
}

export interface ListQuietHoursAllowancesResponse {
  readonly mainThreadId: string | null;
  readonly allowances: readonly { readonly id: string; readonly title: string }[];
}

export const listQuietHoursAllowancesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mainThreadId", "allowances"],
  properties: {
    mainThreadId: { anyOf: [{ type: "string" }, { type: "null" }] },
    allowances: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: { id: { type: "string" }, title: { type: "string" } }
      }
    }
  }
} as const;

export const listQuietHoursAllowancesRouteSchema = {
  response: {
    200: listQuietHoursAllowancesResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

const messageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "threadId", "body"],
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    body: { type: "string" },
    scheduledReadSource: { type: "string", enum: ["tasks"] }
  }
} as const;

export const listScheduledTasksResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    approvedScopes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "version", "state", "approvedAt", "scope"],
        properties: {
          id: { type: "string" },
          version: { type: "integer", minimum: 1 },
          state: { type: "string", enum: ["not_active"] },
          approvedAt: { type: "string" },
          scope: {
            type: "object",
            additionalProperties: false,
            required: [
              "operation",
              "taskId",
              "taskTitle",
              "status",
              "dueAt",
              "timeZone",
              "destinationThreadId"
            ],
            properties: {
              operation: { type: "string", enum: ["tasks.updateStatus"] },
              taskId: { type: "string" },
              taskTitle: { type: "string" },
              status: { type: "string", enum: ["done"] },
              dueAt: { type: "string" },
              timeZone: { type: "string" },
              destinationThreadId: { type: "string" }
            }
          }
        }
      }
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "instruction",
          "group",
          "state",
          "dueAt",
          "deadlineAt",
          "createdAt",
          "runs"
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          instruction: { type: "string" },
          schedule: { anyOf: [{ type: "string" }, { type: "null" }] },
          timeZone: { anyOf: [{ type: "string" }, { type: "null" }] },
          group: { type: "string", enum: ["Reminders", "Daily", "Weekly", "More often"] },
          state: {
            type: "string",
            enum: ["active", "paused", "completed", "expired", "failed", "cancelled"]
          },
          dueAt: { type: "string" },
          deadlineAt: { anyOf: [{ type: "string" }, { type: "null" }] },
          createdAt: { type: "string" },
          runs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["at", "outcome", "summary", "message"],
              properties: {
                at: { type: "string" },
                outcome: { type: "string", enum: ["delivered", "expired"] },
                summary: { type: "string" },
                message: { anyOf: [messageSchema, { type: "null" }] }
              }
            }
          }
        }
      }
    }
  }
} as const;

export const listScheduledTasksRouteSchema = {
  response: {
    200: listScheduledTasksResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;

export interface ScheduledTaskControlResponse {
  readonly ok: true;
}
export const scheduledTaskControlRouteSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } }
  },
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean", const: true } }
    },
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema,
    409: errorResponseSchema,
    503: errorResponseSchema
  }
} as const;
