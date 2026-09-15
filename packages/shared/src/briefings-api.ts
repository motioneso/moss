import { errorResponseSchema, idParamsSchema, jsonObjectSchema } from "./schema-fragments.js";
import {
  briefingPlanContextV1Schema,
  briefingStructuredPayloadV1Schema,
  type BriefingPlanContextV1,
  type BriefingStructuredPayloadV1
} from "./briefing-action-rows.js";

export type BriefingCadence = "manual" | "daily" | "weekly";
export type BriefingRunKind = "manual" | "scheduled";
export type BriefingRunStatus = "succeeded" | "blocked" | "failed";
export type BriefingType = "morning" | "evening" | "weekly_review";

export interface BriefingScheduleMetadataV1 {
  readonly [key: string]: unknown;
  readonly version: 1;
  readonly targetTime: string;
  readonly timezone: string;
  readonly dayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly quietHoursBehavior: "defer_notification";
}

export interface BriefingDefinitionDto {
  readonly id: string;
  readonly ownerUserId: string;
  readonly title: string;
  readonly briefingType: BriefingType;
  readonly cadence: BriefingCadence;
  readonly scheduleMetadata: BriefingScheduleMetadataV1 | Record<string, unknown>;
  readonly enabled: boolean;
  readonly selectedToolNames: readonly string[];
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BriefingRunDto {
  readonly id: string;
  readonly definitionId: string;
  readonly ownerUserId: string;
  readonly status: BriefingRunStatus;
  readonly runKind: BriefingRunKind;
  readonly briefingType: BriefingType;
  readonly summaryText: string;
  readonly sourceMetadata: Record<string, unknown>;
  readonly feedbackItems: readonly BriefingFeedbackItemDto[];
  readonly structuredPayload: BriefingStructuredPayloadV1;
  readonly createdAt: string;
}

export interface BriefingFeedbackItemDto {
  readonly feedbackItemId: string;
  readonly targetKind: "briefing_item";
  readonly surface: "briefing";
  readonly sourceKind: string;
  readonly sourceLabel: string;
  readonly priorityBand: "critical" | "high" | "normal" | "low" | null;
  readonly metadata: Record<string, unknown>;
}

export interface ListBriefingDefinitionsResponse {
  readonly definitions: readonly BriefingDefinitionDto[];
}

export interface CreateBriefingDefinitionRequest {
  readonly title: string;
  readonly briefingType?: BriefingType;
  readonly cadence?: BriefingCadence;
  readonly scheduleMetadata?: BriefingScheduleMetadataV1 | Record<string, unknown>;
  readonly enabled?: boolean;
  readonly selectedToolNames?: readonly string[];
}

export interface CreateBriefingDefinitionResponse {
  readonly definition: BriefingDefinitionDto;
}

export interface UpdateBriefingDefinitionRequest {
  readonly title?: string;
  readonly briefingType?: BriefingType;
  readonly cadence?: BriefingCadence;
  readonly scheduleMetadata?: BriefingScheduleMetadataV1 | Record<string, unknown>;
  readonly enabled?: boolean;
  readonly selectedToolNames?: readonly string[];
}

export interface UpdateBriefingDefinitionResponse {
  readonly definition: BriefingDefinitionDto;
}

export interface RunBriefingDefinitionRequest {
  readonly idempotencyKey?: string;
}

export interface RunBriefingDefinitionResponse {
  readonly jobId: string;
  readonly runId: string;
}

export interface ListBriefingRunsResponse {
  readonly runs: readonly BriefingRunDto[];
}

export type BriefingRunReadState = "pending" | "failed" | "ready";

export type BriefingRunPlanStatus = "current" | "changed" | "none" | "unavailable";

export interface BriefingRunPlanStateDto {
  readonly status: BriefingRunPlanStatus;
  readonly storedRevision: number | null;
  readonly currentRevision: number | null;
  readonly current: BriefingPlanContextV1 | null;
}

export interface GetBriefingRunResponse {
  readonly state: BriefingRunReadState;
  readonly run: BriefingRunDto | null;
  readonly latest: boolean;
  readonly plan: BriefingRunPlanStateDto | null;
}

export interface BriefingRunPayloadDto {
  readonly actorUserId: string;
  readonly definitionId: string;
  readonly briefingRunId: string;
  readonly runKind: BriefingRunKind;
  readonly briefingType: BriefingType;
  readonly idempotencyKey?: string;
}

export const briefingCadenceSchema = {
  type: "string",
  enum: ["manual", "daily", "weekly"]
} as const;

export const briefingRunKindSchema = {
  type: "string",
  enum: ["manual", "scheduled"]
} as const;

export const briefingRunStatusSchema = {
  type: "string",
  enum: ["succeeded", "blocked", "failed"]
} as const;

export const briefingTypeSchema = {
  type: "string",
  enum: ["morning", "evening", "weekly_review"]
} as const;

const selectedToolNamesSchema = {
  type: "array",
  items: { type: "string" }
} as const;

const briefingDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "ownerUserId",
    "title",
    "briefingType",
    "cadence",
    "scheduleMetadata",
    "enabled",
    "selectedToolNames",
    "lastRunAt",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    ownerUserId: { type: "string" },
    title: { type: "string" },
    briefingType: briefingTypeSchema,
    cadence: briefingCadenceSchema,
    scheduleMetadata: jsonObjectSchema,
    enabled: { type: "boolean" },
    selectedToolNames: selectedToolNamesSchema,
    lastRunAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
} as const;

const briefingRunSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "definitionId",
    "ownerUserId",
    "status",
    "runKind",
    "briefingType",
    "summaryText",
    "sourceMetadata",
    "feedbackItems",
    "structuredPayload",
    "createdAt"
  ],
  properties: {
    id: { type: "string" },
    definitionId: { type: "string" },
    ownerUserId: { type: "string" },
    status: briefingRunStatusSchema,
    runKind: briefingRunKindSchema,
    briefingType: briefingTypeSchema,
    summaryText: { type: "string" },
    sourceMetadata: jsonObjectSchema,
    feedbackItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "feedbackItemId",
          "targetKind",
          "surface",
          "sourceKind",
          "sourceLabel",
          "priorityBand",
          "metadata"
        ],
        properties: {
          feedbackItemId: { type: "string" },
          targetKind: { type: "string", enum: ["briefing_item"] },
          surface: { type: "string", enum: ["briefing"] },
          sourceKind: { type: "string" },
          sourceLabel: { type: "string" },
          priorityBand: {
            type: ["string", "null"],
            enum: ["critical", "high", "normal", "low", null]
          },
          metadata: jsonObjectSchema
        }
      }
    },
    structuredPayload: briefingStructuredPayloadV1Schema,
    createdAt: { type: "string" }
  }
} as const;

export const createBriefingDefinitionRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string" },
    briefingType: briefingTypeSchema,
    cadence: briefingCadenceSchema,
    scheduleMetadata: jsonObjectSchema,
    enabled: { type: "boolean" },
    selectedToolNames: selectedToolNamesSchema
  }
} as const;

export const updateBriefingDefinitionRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    briefingType: briefingTypeSchema,
    cadence: briefingCadenceSchema,
    scheduleMetadata: jsonObjectSchema,
    enabled: { type: "boolean" },
    selectedToolNames: selectedToolNamesSchema
  }
} as const;

export const runBriefingDefinitionRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    idempotencyKey: { type: "string", minLength: 1, maxLength: 200 }
  }
} as const;

export const briefingRunPayloadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actorUserId", "definitionId", "briefingRunId", "runKind", "briefingType"],
  properties: {
    actorUserId: { type: "string" },
    definitionId: { type: "string" },
    briefingRunId: { type: "string" },
    runKind: briefingRunKindSchema,
    briefingType: briefingTypeSchema,
    idempotencyKey: { type: "string" }
  }
} as const;

export const listBriefingDefinitionsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definitions"],
  properties: {
    definitions: { type: "array", items: briefingDefinitionSchema }
  }
} as const;

export const createBriefingDefinitionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["definition"],
  properties: {
    definition: briefingDefinitionSchema
  }
} as const;

export const updateBriefingDefinitionResponseSchema = createBriefingDefinitionResponseSchema;

export const runBriefingDefinitionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "runId"],
  properties: {
    jobId: { type: "string" },
    runId: { type: "string" }
  }
} as const;

export const listBriefingRunsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runs"],
  properties: {
    runs: { type: "array", items: briefingRunSchema }
  }
} as const;

export const briefingRunPlanStateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "storedRevision", "currentRevision", "current"],
  properties: {
    status: { type: "string", enum: ["current", "changed", "none", "unavailable"] },
    storedRevision: { type: ["integer", "null"] },
    currentRevision: { type: ["integer", "null"] },
    current: { anyOf: [briefingPlanContextV1Schema, { type: "null" }] }
  }
} as const;

export const getBriefingRunResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state", "run", "latest", "plan"],
  properties: {
    state: { type: "string", enum: ["pending", "failed", "ready"] },
    run: { anyOf: [briefingRunSchema, { type: "null" }] },
    latest: { type: "boolean" },
    plan: { anyOf: [briefingRunPlanStateSchema, { type: "null" }] }
  }
} as const;

export const briefingRunParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "runId"],
  properties: {
    id: { type: "string" },
    runId: { type: "string" }
  }
} as const;

export const listBriefingDefinitionsRouteSchema = {
  response: {
    200: listBriefingDefinitionsResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const createBriefingDefinitionRouteSchema = {
  body: createBriefingDefinitionRequestSchema,
  response: {
    201: createBriefingDefinitionResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema
  }
} as const;

export const updateBriefingDefinitionRouteSchema = {
  params: idParamsSchema,
  body: updateBriefingDefinitionRequestSchema,
  response: {
    200: updateBriefingDefinitionResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const runBriefingDefinitionRouteSchema = {
  params: idParamsSchema,
  body: runBriefingDefinitionRequestSchema,
  response: {
    202: runBriefingDefinitionResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const listBriefingRunsRouteSchema = {
  params: idParamsSchema,
  response: {
    200: listBriefingRunsResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;

export const getBriefingRunRouteSchema = {
  params: briefingRunParamsSchema,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      jobId: { type: "string", minLength: 1, maxLength: 200 }
    }
  },
  response: {
    200: getBriefingRunResponseSchema,
    401: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
