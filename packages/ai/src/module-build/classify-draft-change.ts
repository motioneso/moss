/**
 * Classifies a requested change to a running draft (#1756) so "make it bigger" can never smuggle
 * in a new outside service: a cosmetic change is applied directly; a change that would reach
 * somewhere the current plan doesn't already name raises the plan-approval card again, scoped to
 * just the new line.
 *
 * `ModuleBuildPlan` and `writeModuleBuildPlan`'s shape mirror Task 14's not-yet-landed
 * `packages/ai/src/module-build/write-plan.ts` — defined locally so this file wires to the real
 * implementation unchanged once that lands.
 */

export interface ModuleBuildPlan {
  readonly whatItDoes: string;
  readonly whatItReaches: readonly string[];
  readonly whatItKeeps: string;
  readonly whenItRuns: string;
  readonly roughCost: { readonly time: string; readonly budgetCents: number };
}

export type ClassifyDraftChangeResult =
  | { readonly kind: "cosmetic" }
  | { readonly kind: "new-external-service"; readonly plan: ModuleBuildPlan };

export interface ClassifyDraftChangeDeps {
  readonly getCurrentPlan: (buildId: string) => Promise<ModuleBuildPlan>;
  readonly writeModuleBuildPlan: (input: {
    readonly description: string;
    readonly conversationExcerpt: string;
  }) => Promise<ModuleBuildPlan>;
}

export async function classifyDraftChangeRequest(
  deps: ClassifyDraftChangeDeps,
  buildId: string,
  requestText: string
): Promise<ClassifyDraftChangeResult> {
  const currentPlan = await deps.getCurrentPlan(buildId);
  const revisedPlan = await deps.writeModuleBuildPlan({
    description: requestText,
    conversationExcerpt: requestText
  });

  const reachesSomethingNew = revisedPlan.whatItReaches.some(
    (line) => !currentPlan.whatItReaches.includes(line)
  );

  if (!reachesSomethingNew) {
    return { kind: "cosmetic" };
  }

  return { kind: "new-external-service", plan: revisedPlan };
}
