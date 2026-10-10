import { nullableStringSchema } from "./schema-fragments.js";
import type { TaskQuadrant } from "./tasks-view.js";
import {
  taskSuggestionMetadataV1Schema,
  type TaskSuggestionMetadataV1
} from "./briefing-action-rows.js";

export const TASK_STATUSES = ["todo", "suggested", "done", "archived"] as const;
export const TASK_EFFORTS = ["quick", "medium", "large"] as const;

export type TaskApiStatus = (typeof TASK_STATUSES)[number];
export type TaskEffort = (typeof TASK_EFFORTS)[number];
export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequencyDto = (typeof RECURRENCE_FREQUENCIES)[number];
export const TASK_QUADRANTS = ["do", "schedule", "delegate", "eliminate"] as const;

export interface RecurrenceSpecDto {
  readonly freq: RecurrenceFrequencyDto;
  readonly interval: number;
  readonly occurrence_date: string;
}

export interface TaskTagDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly listId: string;
  readonly name: string;
  readonly createdAt: string | null;
}

export interface TaskDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly listId: string;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskApiStatus;
  readonly priority: number | null;
  readonly position: number;
  readonly dueAt: string | null;
  readonly doAt: string | null;
  readonly effort: TaskEffort | null;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly tags: readonly TaskTagDto[];
  readonly suggestionMetadata: TaskSuggestionMetadataV1 | null;
  readonly recurrence?: RecurrenceSpecDto | null;
}

export interface TaskActivityDto {
  readonly id: string;
  readonly taskId: string;
  readonly actorUserId: string;
  readonly activityType: string;
  readonly body: string | null;
  readonly createdAt: string | null;
}

export interface ListTasksResponse {
  readonly tasks: readonly TaskDto[];
}

export interface InterpretTaskSearchRequest {
  readonly query: string;
}

export type TaskSearchDueIntent =
  | { readonly kind: "none" }
  | { readonly kind: "overdue" }
  | { readonly kind: "today" }
  | { readonly kind: "this_week" }
  | {
      readonly kind: "range";
      readonly dueAfter: string | null;
      readonly dueBefore: string | null;
    };

export interface TaskSearchIntent {
  readonly text: string | null;
  readonly status: TaskApiStatus | null;
  readonly effort: TaskEffort | null;
  readonly priority: number | null;
  readonly listIds: readonly string[];
  readonly tagNames: readonly string[];
  readonly quadrant: TaskQuadrant | null;
  readonly due: TaskSearchDueIntent | null;
}

export interface InterpretTaskSearchResponse {
  readonly intent: TaskSearchIntent;
  readonly confidence: "high" | "medium" | "low";
  readonly warnings: readonly string[];
}

export interface CreateTaskRequest {
  readonly title: string;
  readonly description?: string | null;
  readonly status?: TaskApiStatus;
  readonly priority?: number | null;
  readonly dueAt?: string | null;
  readonly listId?: string;
  readonly doAt?: string | null;
  readonly effort?: TaskEffort | null;
  readonly parentTaskId?: string | null;
  readonly recurrence?: RecurrenceSpecDto | null;
}

export interface CreateTaskResponse {
  readonly task: TaskDto;
}

export interface GetTaskResponse {
  readonly task: TaskDto;
}

export interface UpdateTaskRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskApiStatus;
  readonly priority?: number | null;
  readonly dueAt?: string | null;
  readonly listId?: string;
  readonly doAt?: string | null;
  readonly effort?: TaskEffort | null;
  readonly parentTaskId?: string | null;
  readonly recurrence?: RecurrenceSpecDto | null;
}

export interface UpdateTaskResponse {
  readonly task: TaskDto;
}

export interface AddTaskActivityRequest {
  readonly activityType?: string;
  readonly body?: string | null;
}

export interface AddTaskActivityResponse {
  readonly activity: TaskActivityDto;
}

export interface ListTaskActivityResponse {
  readonly activity: readonly TaskActivityDto[];
}

export interface DeferredTaskStatusRequest {
  readonly status: TaskApiStatus;
  readonly idempotencyKey?: string;
}

export interface DeferredTaskStatusResponse {
  readonly jobId: string | null;
}

export interface DeferredTaskStatusPayloadDto {
  readonly actorUserId: string;
  readonly taskId: string;
  readonly requestedStatus: TaskApiStatus;
  readonly idempotencyKey?: string;
}

const nullableNumberSchema = {
  anyOf: [{ type: "number" }, { type: "null" }]
} as const;

export const taskStatusSchema = {
  type: "string",
  enum: TASK_STATUSES
} as const;

export const taskQuadrantSchema = {
  type: "string",
  enum: TASK_QUADRANTS
} as const;

export const recurrenceSpecDtoSchema = {
  type: "object",
  additionalProperties: false,
  required: ["freq", "interval", "occurrence_date"],
  properties: {
    freq: { type: "string", enum: RECURRENCE_FREQUENCIES },
    interval: { type: "integer", minimum: 1 },
    occurrence_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }
  }
} as const;

export const taskParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string" }
  }
} as const;

const nullableEffortSchema = {
  anyOf: [{ type: "string", enum: ["quick", "medium", "large"] }, { type: "null" }]
} as const;

const taskSearchDueIntentSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", enum: ["none", "overdue", "today", "this_week"] } }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "dueAfter", "dueBefore"],
      properties: {
        kind: { type: "string", enum: ["range"] },
        dueAfter: nullableStringSchema,
        dueBefore: nullableStringSchema
      }
    },
    { type: "null" }
  ]
} as const;

export const interpretTaskSearchRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 300 }
  }
} as const;

export const taskSearchIntentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "status", "effort", "priority", "listIds", "tagNames", "quadrant", "due"],
  properties: {
    text: nullableStringSchema,
    status: { anyOf: [taskStatusSchema, { type: "null" }] },
    effort: nullableEffortSchema,
    priority: {
      anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }]
    },
    listIds: { type: "array", items: { type: "string" } },
    tagNames: { type: "array", items: { type: "string" } },
    quadrant: { anyOf: [taskQuadrantSchema, { type: "null" }] },
    due: taskSearchDueIntentSchema
  }
} as const;

export const interpretTaskSearchResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "warnings"],
  properties: {
    intent: taskSearchIntentSchema,
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    warnings: { type: "array", items: { type: "string" } }
  }
} as const;

export const taskTagDtoSchema = {
  type: "object",
  required: ["id", "ownerUserId", "listId", "name", "createdAt"],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    listId: { type: "string" },
    name: { type: "string" },
    createdAt: nullableStringSchema
  }
} as const;

export const taskDtoSchema = {
  type: "object",
  required: [
    "id",
    "ownerUserId",
    "listId",
    "parentTaskId",
    "title",
    "description",
    "status",
    "priority",
    "position",
    "dueAt",
    "doAt",
    "effort",
    "source",
    "sourceRef",
    "completedAt",
    "createdAt",
    "updatedAt",
    "tags",
    "suggestionMetadata"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    listId: { type: "string" },
    parentTaskId: nullableStringSchema,
    title: { type: "string" },
    description: nullableStringSchema,
    status: taskStatusSchema,
    priority: nullableNumberSchema,
    position: { type: "number" },
    dueAt: nullableStringSchema,
    doAt: nullableStringSchema,
    effort: nullableEffortSchema,
    source: { type: "string" },
    sourceRef: nullableStringSchema,
    completedAt: nullableStringSchema,
    createdAt: nullableStringSchema,
    updatedAt: nullableStringSchema,
    tags: { type: "array", items: taskTagDtoSchema },
    suggestionMetadata: { anyOf: [taskSuggestionMetadataV1Schema, { type: "null" }] },
    recurrence: { anyOf: [recurrenceSpecDtoSchema, { type: "null" }] }
  },
  additionalProperties: false
} as const;

export const taskActivityDtoSchema = {
  type: "object",
  required: ["id", "taskId", "actorUserId", "activityType", "body", "createdAt"],
  properties: {
    id: { type: "string" },
    taskId: { type: "string" },
    actorUserId: { type: "string" },
    activityType: { type: "string" },
    body: nullableStringSchema,
    createdAt: nullableStringSchema
  }
} as const;

export const listTasksResponseSchema = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: taskDtoSchema
    }
  }
} as const;

export const focusSignalDtoSchema = {
  type: "object",
  required: ["moduleId", "readiness", "summary"],
  properties: {
    moduleId: { type: "string" },
    readiness: { type: "number" },
    summary: { type: "string" }
  }
} as const;

export interface FocusSignalDto {
  readonly moduleId: string;
  readonly readiness: number;
  readonly summary: string;
}

export const focusTasksResponseSchema = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: { type: "array", items: taskDtoSchema },
    signals: { type: "array", items: focusSignalDtoSchema }
  }
} as const;

export interface FocusTasksResponse {
  readonly tasks: readonly TaskDto[];
  readonly signals?: readonly FocusSignalDto[];
}

export const atRiskTasksResponseSchema = listTasksResponseSchema;
export const overdueTasksResponseSchema = listTasksResponseSchema;

export const createTaskRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string" },
    description: nullableStringSchema,
    status: taskStatusSchema,
    priority: {
      anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }]
    },
    dueAt: nullableStringSchema,
    listId: { type: "string" },
    doAt: nullableStringSchema,
    effort: nullableEffortSchema,
    parentTaskId: nullableStringSchema,
    recurrence: {
      anyOf: [recurrenceSpecDtoSchema, { type: "null" }]
    }
  }
} as const;

export const createTaskResponseSchema = {
  type: "object",
  required: ["task"],
  properties: {
    task: taskDtoSchema
  }
} as const;

export const getTaskResponseSchema = createTaskResponseSchema;

export const updateTaskRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    description: nullableStringSchema,
    status: taskStatusSchema,
    priority: {
      anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }]
    },
    dueAt: nullableStringSchema,
    listId: { type: "string" },
    doAt: nullableStringSchema,
    effort: nullableEffortSchema,
    parentTaskId: nullableStringSchema,
    recurrence: {
      anyOf: [recurrenceSpecDtoSchema, { type: "null" }]
    }
  }
} as const;

export const updateTaskResponseSchema = createTaskResponseSchema;

export const addTaskActivityRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    activityType: { type: "string" },
    body: nullableStringSchema
  }
} as const;

export const addTaskActivityResponseSchema = {
  type: "object",
  required: ["activity"],
  properties: {
    activity: taskActivityDtoSchema
  }
} as const;

export const deferredTaskStatusRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: taskStatusSchema,
    idempotencyKey: { type: "string" }
  }
} as const;

export const deferredTaskStatusResponseSchema = {
  type: "object",
  required: ["jobId"],
  properties: {
    jobId: nullableStringSchema
  }
} as const;

export const deferredTaskStatusPayloadSchema = {
  type: "object",
  required: ["actorUserId", "taskId", "requestedStatus"],
  properties: {
    actorUserId: { type: "string" },
    taskId: { type: "string" },
    requestedStatus: taskStatusSchema,
    idempotencyKey: { type: "string" }
  }
} as const;

export const listTasksRouteSchema = {
  response: {
    200: listTasksResponseSchema
  }
} as const;

export const interpretTaskSearchRouteSchema = {
  body: interpretTaskSearchRequestSchema,
  response: {
    200: interpretTaskSearchResponseSchema
  }
} as const;

export const createTaskRouteSchema = {
  body: createTaskRequestSchema,
  response: {
    201: createTaskResponseSchema
  }
} as const;

export const getTaskRouteSchema = {
  params: taskParamsSchema,
  response: {
    200: getTaskResponseSchema
  }
} as const;

export const updateTaskRouteSchema = {
  params: taskParamsSchema,
  body: updateTaskRequestSchema,
  response: {
    200: updateTaskResponseSchema
  }
} as const;

export const addTaskActivityRouteSchema = {
  params: taskParamsSchema,
  body: addTaskActivityRequestSchema,
  response: {
    201: addTaskActivityResponseSchema
  }
} as const;

export const listTaskActivityResponseSchema = {
  type: "object",
  required: ["activity"],
  properties: {
    activity: { type: "array", items: taskActivityDtoSchema }
  }
} as const;

export const listTaskActivityRouteSchema = {
  params: taskParamsSchema,
  response: {
    200: listTaskActivityResponseSchema
  }
} as const;

export const deferredTaskStatusRouteSchema = {
  params: taskParamsSchema,
  body: deferredTaskStatusRequestSchema,
  response: {
    202: deferredTaskStatusResponseSchema
  }
} as const;

// --- Task Lists ---

export interface TaskListDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface ListTaskListsResponse {
  readonly lists: readonly TaskListDto[];
}

export interface CreateTaskListRequest {
  readonly name: string;
}

export interface CreateTaskListResponse {
  readonly list: TaskListDto;
}

export const taskListDtoSchema = {
  type: "object",
  required: ["id", "ownerUserId", "name", "position", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    name: { type: "string" },
    position: { type: "number" },
    createdAt: nullableStringSchema,
    updatedAt: nullableStringSchema
  }
} as const;

export const listTaskListsResponseSchema = {
  type: "object",
  required: ["lists"],
  properties: {
    lists: { type: "array", items: taskListDtoSchema }
  }
} as const;

export const createTaskListRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string" }
  }
} as const;

export const createTaskListResponseSchema = {
  type: "object",
  required: ["list"],
  properties: {
    list: taskListDtoSchema
  }
} as const;

export const listTaskListsRouteSchema = {
  response: {
    200: listTaskListsResponseSchema
  }
} as const;

export const taskListParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId"],
  properties: {
    listId: { type: "string" }
  }
} as const;

export const createTaskListRouteSchema = {
  body: createTaskListRequestSchema,
  response: {
    201: createTaskListResponseSchema
  }
} as const;

// --- Task Tags ---

export interface ListTaskTagsResponse {
  readonly tags: readonly TaskTagDto[];
}

export interface CreateTaskTagRequest {
  readonly name: string;
}

export interface CreateTaskTagResponse {
  readonly tag: TaskTagDto;
}

export const listTaskTagsResponseSchema = {
  type: "object",
  required: ["tags"],
  properties: {
    tags: { type: "array", items: taskTagDtoSchema }
  }
} as const;

export const createTaskTagRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string" }
  }
} as const;

export const createTaskTagResponseSchema = {
  type: "object",
  required: ["tag"],
  properties: {
    tag: taskTagDtoSchema
  }
} as const;

export const listTaskTagsRouteSchema = {
  params: taskListParamsSchema,
  response: {
    200: listTaskTagsResponseSchema
  }
} as const;

export const createTaskTagRouteSchema = {
  params: taskListParamsSchema,
  body: createTaskTagRequestSchema,
  response: {
    201: createTaskTagResponseSchema
  }
} as const;

// --- Task Breakdown ---

export interface BreakdownTaskRequest {
  readonly steps: readonly string[];
}

export interface BreakdownTaskResponse {
  readonly tasks: readonly TaskDto[];
}

export const breakdownTaskRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: { type: "array", items: { type: "string" } }
  }
} as const;

export const breakdownTaskResponseSchema = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: { type: "array", items: taskDtoSchema }
  }
} as const;

export const breakdownTaskRouteSchema = {
  params: taskParamsSchema,
  body: breakdownTaskRequestSchema,
  response: {
    201: breakdownTaskResponseSchema
  }
} as const;

// --- Focus / At-Risk / Overdue (reuse listTasksResponseSchema shape) ---

export const focusTasksRouteSchema = {
  response: {
    200: focusTasksResponseSchema
  }
} as const;

export const atRiskTasksRouteSchema = {
  response: {
    200: atRiskTasksResponseSchema
  }
} as const;

export const overdueTasksRouteSchema = {
  response: {
    200: overdueTasksResponseSchema
  }
} as const;

// --- Task Preferences ---

export type TaskDefaultView = "priority" | "matrix";

export interface TaskPreferencesDto {
  readonly defaultView: TaskDefaultView;
  readonly updatedAt: string | null;
}

export interface GetTaskPreferencesResponse {
  readonly preferences: TaskPreferencesDto;
}

export interface UpdateTaskPreferencesRequest {
  readonly defaultView: TaskDefaultView;
}

export interface UpdateTaskPreferencesResponse {
  readonly preferences: TaskPreferencesDto;
}

export const taskPreferencesDtoSchema = {
  type: "object",
  required: ["defaultView", "updatedAt"],
  properties: {
    defaultView: { type: "string", enum: ["priority", "matrix"] },
    updatedAt: nullableStringSchema
  }
} as const;

export const getTaskPreferencesResponseSchema = {
  type: "object",
  required: ["preferences"],
  properties: { preferences: taskPreferencesDtoSchema }
} as const;

export const updateTaskPreferencesRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["defaultView"],
  properties: { defaultView: { type: "string", enum: ["priority", "matrix"] } }
} as const;

export const getTaskPreferencesRouteSchema = {
  response: { 200: getTaskPreferencesResponseSchema }
} as const;

export const updateTaskPreferencesRouteSchema = {
  body: updateTaskPreferencesRequestSchema,
  response: { 200: getTaskPreferencesResponseSchema }
} as const;

export interface TaskAgencyAutoExecuteResponse {
  readonly enabled: boolean;
}

export interface UpdateTaskAgencyAutoExecuteRequest {
  readonly enabled: boolean;
}

export const taskAgencyAutoExecuteResponseSchema = {
  type: "object",
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" }
  }
} as const;

export const updateTaskAgencyAutoExecuteRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean" }
  }
} as const;

export const getTaskAgencyAutoExecuteRouteSchema = {
  response: { 200: taskAgencyAutoExecuteResponseSchema }
} as const;

export const updateTaskAgencyAutoExecuteRouteSchema = {
  body: updateTaskAgencyAutoExecuteRequestSchema,
  response: { 200: taskAgencyAutoExecuteResponseSchema }
} as const;

export const listSubtasksRouteSchema = {
  params: taskParamsSchema,
  response: { 200: listTasksResponseSchema }
} as const;

// --- Tag assignment ---

export interface AssignTaskTagRequest {
  readonly tagId: string;
}

export const assignTaskTagRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tagId"],
  properties: { tagId: { type: "string" } }
} as const;

// params for DELETE /api/tasks/:id/tags/:tagId
export const taskTagParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "tagId"],
  properties: { id: { type: "string" }, tagId: { type: "string" } }
} as const;

export const assignTaskTagRouteSchema = {
  params: taskParamsSchema,
  body: assignTaskTagRequestSchema,
  response: { 200: getTaskResponseSchema }
} as const;

export const unassignTaskTagRouteSchema = {
  params: taskTagParamsSchema,
  response: { 200: getTaskResponseSchema }
} as const;

// --- List/tag rename + delete ---

export interface RenameTaskListRequest {
  readonly name: string;
}
export interface DeleteTaskListRequest {
  readonly reassignToListId?: string;
}
export interface RenameTaskTagRequest {
  readonly name: string;
}

export const renameTaskListRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } }
} as const;

export const deleteTaskListRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: { reassignToListId: { type: "string" } }
} as const;

export const renameTaskTagRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } }
} as const;

// params for /api/tasks/lists/:listId/tags/:tagId
export const taskListTagParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["listId", "tagId"],
  properties: { listId: { type: "string" }, tagId: { type: "string" } }
} as const;

export const renameTaskListRouteSchema = {
  params: taskListParamsSchema,
  body: renameTaskListRequestSchema,
  response: { 200: createTaskListResponseSchema }
} as const;

export const deleteTaskListRouteSchema = {
  params: taskListParamsSchema,
  body: deleteTaskListRequestSchema,
  response: {
    200: { type: "object", required: ["deleted"], properties: { deleted: { type: "boolean" } } }
  }
} as const;

export const renameTaskTagRouteSchema = {
  params: taskListTagParamsSchema,
  body: renameTaskTagRequestSchema,
  response: { 200: createTaskTagResponseSchema }
} as const;

export const deleteTaskTagRouteSchema = {
  params: taskListTagParamsSchema,
  response: {
    200: { type: "object", required: ["deleted"], properties: { deleted: { type: "boolean" } } }
  }
} as const;
