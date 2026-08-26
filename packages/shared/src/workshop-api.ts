/**
 * Workshop contracts — #1888: asking Moss for a module in chat.
 *
 * The plan schema is the SANITIZATION BOUNDARY for the assistant tool: the gateway projects the
 * tool's result through `outputSchema` before it reaches the model or (for a tool that opts into
 * `streamsStructuredResult`) the browser. Anything not declared here is dropped, so keep this
 * schema to exactly the fields the plan card renders.
 */

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
  required: ["description"],
  properties: {
    description: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "What the user wants the new module to do, in their own words."
    },
    conversationExcerpt: {
      type: "string",
      maxLength: 8000,
      description:
        "The part of this conversation that establishes the requirements, so the planner has the details the description leaves out."
    }
  }
} as const;

export const workshopBuildModuleResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["buildId", "awaitingApproval", "plan"],
  properties: {
    buildId: { type: "string" },
    awaitingApproval: { type: "boolean" },
    plan: moduleBuildPlanSchema
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
