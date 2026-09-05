/** Workshop contracts. Tool result schemas allowlist fields before model/browser delivery. */

export const WORKSHOP_MODULE_ID = "workshop";

export interface WorkshopFeedInput {
  readonly messageId: string;
  readonly text: string;
}

export interface WorkshopFeedEntry extends WorkshopFeedInput {
  readonly projectId: string;
  readonly sequence: string;
  readonly kind: "user_message";
  readonly delivery: "pending";
  readonly createdAt: string;
}

export interface WorkshopProject {
  readonly id: string;
  readonly title: string;
  readonly initialRequest: string;
  readonly context: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkshopProjectInput {
  readonly requestKey: string;
  readonly title: string;
  readonly initialRequest: string;
  readonly context?: string;
}

export interface WorkshopProjectCursor {
  readonly createdAt: string;
  readonly id: string;
}

export const moduleBuildPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["whatItDoes", "whatItReaches", "whatItKeeps", "whenItRuns", "roughCost"],
  properties: {
    whatItDoes: { type: "string" },
    whatItReaches: { type: "array", items: { type: "string" } },
    whatItKeeps: { type: "string" },
    whenItRuns: { type: "string" },
    roughCost: {
      type: "object",
      additionalProperties: false,
      required: ["time", "budgetCents"],
      properties: {
        time: { type: "string" },
        budgetCents: { type: "number" }
      }
    }
  }
} as const;

export const workshopBuildModuleInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestKey", "description"],
  properties: {
    requestKey: {
      type: "string",
      format: "uuid",
      description:
        "A UUID for this project request. Reuse it unchanged when retrying the same request."
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "What the user wants the new module to do, in their own words."
    }
  }
} as const;

export const approveModuleBuildResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["buildId", "status"],
  properties: {
    buildId: { type: "string" },
    status: { type: "string" }
  }
} as const;

export interface ApproveModuleBuildResponse {
  readonly buildId: string;
  readonly status: string;
}

/**
 * #1945 — the Workshop page's "my builds" list.
 *
 * `ModuleBuildPlan` mirrors `moduleBuildPlanSchema` above (kept as one hand-written shape, not
 * two, since the schema has no type-inference helper in this package).
 */
export type ModuleBuildStatus =
  | "planning"
  | "awaiting_plan_approval"
  | "building"
  | "awaiting_change"
  | "ready"
  | "failed"
  | "cancelled";

export interface ModuleBuildPlan {
  readonly whatItDoes: string;
  readonly whatItReaches: readonly string[];
  readonly whatItKeeps: string;
  readonly whenItRuns: string;
  readonly roughCost: {
    readonly time: string;
    readonly budgetCents: number;
  };
}

export interface ModuleBuildSummary {
  readonly id: string;
  readonly status: ModuleBuildStatus;
  readonly step: string | null;
  readonly moduleId: string | null;
  readonly plan: ModuleBuildPlan | null;
  readonly fetchedUrls: readonly string[];
  readonly writtenFiles: readonly string[];
  readonly costCents: number;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const moduleBuildStatusSchema = {
  type: "string",
  enum: [
    "planning",
    "awaiting_plan_approval",
    "building",
    "awaiting_change",
    "ready",
    "failed",
    "cancelled"
  ]
} as const;

const moduleBuildSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "status",
    "step",
    "moduleId",
    "plan",
    "fetchedUrls",
    "writtenFiles",
    "costCents",
    "error",
    "createdAt",
    "updatedAt"
  ],
  properties: {
    id: { type: "string" },
    status: moduleBuildStatusSchema,
    step: { type: ["string", "null"] },
    moduleId: { type: ["string", "null"] },
    plan: { anyOf: [moduleBuildPlanSchema, { type: "null" }] },
    fetchedUrls: { type: "array", items: { type: "string" } },
    writtenFiles: { type: "array", items: { type: "string" } },
    costCents: { type: "number" },
    error: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" }
  }
} as const;

export const listMyModuleBuildsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["builds"],
  properties: {
    builds: { type: "array", items: moduleBuildSummarySchema }
  }
} as const;

export interface ListMyModuleBuildsResponse {
  readonly builds: readonly ModuleBuildSummary[];
}

/** #1945 — the Workshop page's "Live" group, populated from the existing `/api/me/modules` data. */
export interface WorkshopLiveModuleSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly scope: "you" | "everyone";
}

export interface CreateWorkshopProjectResponse {
  readonly project: WorkshopProject;
  readonly created: boolean;
  readonly destination: string;
}
export interface ListWorkshopProjectsResponse {
  readonly projects: readonly WorkshopProject[];
  readonly nextCursor: WorkshopProjectCursor | null;
}
export interface GetWorkshopProjectResponse {
  readonly project: WorkshopProject;
}
export interface ListWorkshopMessagesResponse {
  readonly entries: readonly WorkshopFeedEntry[];
  readonly nextCursor: string;
}
export interface CreateWorkshopMessageResponse {
  readonly entry: WorkshopFeedEntry;
  readonly created: boolean;
}

const workshopUuidSchema = { type: "string", format: "uuid" } as const;
const workshopTimestampSchema = { type: "string", format: "date-time" } as const;
const workshopPageLimitSchema = { type: "integer", minimum: 1, maximum: 100 } as const;
export const workshopProjectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId"],
  properties: { projectId: workshopUuidSchema }
} as const;
export const createWorkshopProjectInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestKey", "title", "initialRequest"],
  properties: {
    requestKey: workshopUuidSchema,
    title: { type: "string", minLength: 1, maxLength: 160 },
    initialRequest: { type: "string", minLength: 1, maxLength: 16384 },
    context: { type: "string", maxLength: 16384 }
  }
} as const;
export const listWorkshopProjectsQuerySchema = {
  type: "object",
  additionalProperties: false,
  dependencies: { beforeId: ["beforeCreatedAt"], beforeCreatedAt: ["beforeId"] },
  properties: {
    limit: workshopPageLimitSchema,
    beforeId: workshopUuidSchema,
    beforeCreatedAt: workshopTimestampSchema
  }
} as const;
export const listWorkshopMessagesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: workshopPageLimitSchema,
    after: { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" }
  }
} as const;
export const createWorkshopMessageInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["messageId", "text"],
  properties: {
    messageId: workshopUuidSchema,
    text: { type: "string", minLength: 1, maxLength: 16384 }
  }
} as const;
export const workshopProjectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "initialRequest", "context", "createdAt", "updatedAt"],
  properties: {
    id: workshopUuidSchema,
    title: { type: "string" },
    initialRequest: { type: "string" },
    context: { type: "string" },
    createdAt: workshopTimestampSchema,
    updatedAt: workshopTimestampSchema
  }
} as const;
export const workshopFeedEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "messageId", "sequence", "kind", "text", "delivery", "createdAt"],
  properties: {
    projectId: workshopUuidSchema,
    messageId: workshopUuidSchema,
    sequence: { type: "string" },
    kind: { type: "string", const: "user_message" },
    text: { type: "string" },
    delivery: { type: "string", const: "pending" },
    createdAt: workshopTimestampSchema
  }
} as const;
export const createWorkshopProjectResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project", "created", "destination"],
  properties: {
    project: workshopProjectSchema,
    created: { type: "boolean" },
    destination: { type: "string" }
  }
} as const;
export const getWorkshopProjectResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project"],
  properties: { project: workshopProjectSchema }
} as const;
export const listWorkshopProjectsResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projects", "nextCursor"],
  properties: {
    projects: { type: "array", items: workshopProjectSchema },
    nextCursor: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["id", "createdAt"],
          properties: { id: workshopUuidSchema, createdAt: workshopTimestampSchema }
        }
      ]
    }
  }
} as const;
export const listWorkshopMessagesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entries", "nextCursor"],
  properties: {
    entries: { type: "array", items: workshopFeedEntrySchema },
    nextCursor: { type: "string" }
  }
} as const;
export const createWorkshopMessageResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["entry", "created"],
  properties: { entry: workshopFeedEntrySchema, created: { type: "boolean" } }
} as const;
export const workshopErrorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: { error: { type: "string" } }
} as const;

export type WorkshopProjectCreationResult = CreateWorkshopProjectResponse;

export const workshopBuildModuleResultSchema = createWorkshopProjectResponseSchema;
