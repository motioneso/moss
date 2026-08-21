import type { DataContextDb } from "@moss/db";

import type {
  generateStructured,
  GenerateStructuredDeps
} from "../structured/generate-structured.js";

const MODULE_BUILD_PLAN_SERVICE = "module.moss.workshop-build-plan" as const;

const MODULE_BUILD_PLAN_SCHEMA = {
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

export type ModuleBuildPlan = {
  readonly whatItDoes: string;
  readonly whatItReaches: readonly string[];
  readonly whatItKeeps: string;
  readonly whenItRuns: string;
  readonly roughCost: { readonly time: string; readonly budgetCents: number };
};

export type WriteModuleBuildPlanDeps = {
  readonly generateStructured: typeof generateStructured;
  readonly generateStructuredDeps: GenerateStructuredDeps;
};

export type WriteModuleBuildPlanInput = {
  readonly description: string;
  readonly conversationExcerpt: string;
};

export async function writeModuleBuildPlan(
  scopedDb: DataContextDb,
  deps: WriteModuleBuildPlanDeps,
  input: WriteModuleBuildPlanInput
): Promise<ModuleBuildPlan> {
  const prompt = [
    "A person asked for a small module to be built for them. Describe the plan in five plain lines.",
    `What they asked for: ${input.description}`,
    `Conversation so far: ${input.conversationExcerpt}`
  ].join("\n\n");

  const result = await deps.generateStructured(
    scopedDb,
    {
      service: MODULE_BUILD_PLAN_SERVICE,
      schema: MODULE_BUILD_PLAN_SCHEMA,
      prompt
    },
    deps.generateStructuredDeps
  );

  if (!result.ok) {
    throw new Error(`writeModuleBuildPlan: generateStructured failed with ${result.error}`);
  }

  return result.object as ModuleBuildPlan;
}
