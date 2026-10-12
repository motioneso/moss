import { errorResponseSchema } from "./schema-fragments.js";

export type ScheduledTaskState =
  | "active"
  | "paused"
  | "completed"
  | "expired"
  | "failed"
  | "cancelled";

export interface ScheduledTaskMessageDto {
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
  readonly group: "Reminders";
  readonly state: ScheduledTaskState;
  readonly dueAt: string;
  readonly deadlineAt: string | null;
  readonly createdAt: string;
  readonly runs: readonly ScheduledTaskRunDto[];
}

export interface ListScheduledTasksResponse {
  readonly tasks: readonly ScheduledTaskDto[];
}

const messageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "threadId", "body"],
  properties: { id: { type: "string" }, threadId: { type: "string" }, body: { type: "string" } }
} as const;

export const listScheduledTasksResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
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
          group: { type: "string", enum: ["Reminders"] },
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
