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
