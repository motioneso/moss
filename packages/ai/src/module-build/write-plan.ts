import type { DataContextDb } from "@moss/db";
import { WORKSHOP_PLAN_SERVICE_KEY } from "@moss/shared";

import type {
  generateStructured,
  GenerateStructuredDeps
} from "../structured/generate-structured.js";

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
      service: WORKSHOP_PLAN_SERVICE_KEY,
      tierHint: "reasoning",
      requiredTier: "reasoning",
      sourceGeneration: true,
      schema: MODULE_BUILD_PLAN_SCHEMA,
      prompt
    },
    {
      ...deps.generateStructuredDeps,
      // Provider-global CLI tokens cannot establish the planning actor's credential ownership.
      createCliStructuredAdapter: undefined
    }
  );

  if (!result.ok) {
    if (result.error === "needs_config") {
      throw new Error(
        "Workshop planning needs an available reasoning model with an owner-bound connection. " +
          "Configure Workshop planning in Settings → Administration → AI providers " +
          "(/settings?section=aiproviders). Change or unlock Chat lock if it conflicts, then retry."
      );
    }
    throw new Error(`writeModuleBuildPlan: generateStructured failed with ${result.error}`);
  }

  return result.object as ModuleBuildPlan;
}
