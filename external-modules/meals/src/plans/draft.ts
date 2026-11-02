// external-modules/meals/src/plans/draft.ts
//
// Writes one recipe that passes every rule: the cook-time cap, the brand rule, no repeats, the
// Pantry rule, and Safety for each eater. The day job and the swap job both call it, so a swap
// choice passes exactly what a planned meal passes.

import type { AiFailure } from "../ai/port.js";
import { buildRecipePrompt, parseRecipe, RECIPE_SCHEMA, type RecipeDraft } from "../ai/recipe.js";
import { buildSafetyPrompt, parseSafety, SAFETY_SCHEMA } from "../ai/safety.js";
import type { GenerationFailure, KitchenView, MemberView } from "../contracts.js";
import { offPantry, type PantryInput } from "../domain/pantry.js";
import { isRepeat, titleKey } from "../domain/repeats.js";
import {
  applyBrandRule,
  deterministicSafety,
  mergeSafety,
  type SafetyVerdict
} from "../domain/safety.js";
import { mealShareKcal } from "../domain/targets.js";
import type { PlanRow } from "../store/plan-port.js";
import type { PlanDeps } from "./deps.js";

/** The first attempt plus two regenerations. */
export const MAX_ATTEMPTS = 3;

export interface DraftRequest {
  readonly deps: PlanDeps;
  readonly plan: PlanRow;
  readonly kitchen: KitchenView;
  readonly slotName: string;
  readonly date: string;
  /** One entry per eater, in eater order. Undefined for a member who has been removed. */
  readonly people: readonly (MemberView | undefined)[];
  readonly cookTimeLimitMinutes: number | null;
  readonly avoidTitles: readonly string[];
  readonly recentKeys: ReadonlySet<string>;
  /** Title keys this meal must not use: one-star recipes for the people eating it (S10). */
  readonly vetoedKeys?: ReadonlySet<string>;
  /** Null when the plan ignores the Pantry or there is no Pantry store. */
  readonly pantry: PantryInput | null;
}

export type DraftResult =
  | {
      readonly ok: true;
      readonly draft: RecipeDraft;
      readonly key: string;
      readonly verdicts: readonly SafetyVerdict[];
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly reason: GenerationFailure;
      readonly attempts: number;
      /** The last Safety verdicts, when the final attempt failed Safety. */
      readonly verdicts: readonly SafetyVerdict[] | null;
    };

function pantryText(item: PantryInput["stock"][number]): string {
  if (item.quantity === null) return item.name;
  return `${item.name} (${item.quantity}${item.unit ? ` ${item.unit}` : ""})`;
}

export type SafetyResult =
  | { readonly kind: "verdicts"; readonly verdicts: readonly SafetyVerdict[] }
  | { readonly kind: "error"; readonly reason: AiFailure | "validation_failed" };

/**
 * The deterministic Never serve check first. A rule failure skips the model call. Otherwise the
 * model judges, and a model pass can never clear a rule failure.
 */
export async function checkSafety(
  deps: PlanDeps,
  draft: RecipeDraft,
  restrictions: readonly (readonly string[])[]
): Promise<SafetyResult> {
  const ruleVerdicts = restrictions.map((list) => deterministicSafety(draft.ingredients, list));
  if (ruleVerdicts.some((verdict) => verdict.verdict === "fail")) {
    return { kind: "verdicts", verdicts: ruleVerdicts };
  }
  const judged = await deps.ai.generateStructured({
    schema: SAFETY_SCHEMA,
    prompt: buildSafetyPrompt(
      draft,
      restrictions.map((list) => ({ restrictions: list }))
    ),
    tierHint: "reasoning"
  });
  if (!judged.ok) return { kind: "error", reason: judged.error };
  let modelVerdicts;
  try {
    modelVerdicts = parseSafety(judged.object, restrictions.length);
  } catch {
    return { kind: "error", reason: "validation_failed" };
  }
  return {
    kind: "verdicts",
    verdicts: ruleVerdicts.map((verdict, index) =>
      mergeSafety(verdict, modelVerdicts[index] ?? null)
    )
  };
}

export async function draftSafeRecipe(request: DraftRequest): Promise<DraftResult> {
  const { deps, plan, kitchen, people, pantry } = request;
  const restrictions = people.map((person) => person?.restrictions ?? []);

  let attempts = 0;
  let lastVerdicts: readonly SafetyVerdict[] | null = null;
  let lastRejection: "safety" | "pantry" | "veto" = "safety";
  const fail = (reason: GenerationFailure): DraftResult => ({
    ok: false,
    reason,
    attempts,
    verdicts: lastVerdicts
  });

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const written = await deps.ai.generateStructured({
      schema: RECIPE_SCHEMA,
      prompt: buildRecipePrompt({
        slotName: request.slotName,
        date: request.date,
        eaters: people.map((person) => ({
          shareKcal: person ? mealShareKcal(person, request.slotName) : null,
          restrictions: person?.restrictions ?? [],
          preferences: person?.preferences ?? []
        })),
        cookTimeLimitMinutes: request.cookTimeLimitMinutes,
        requestText: plan.requestText,
        avoidTitles: request.avoidTitles,
        unitsSystem: kitchen.unitsSystem,
        ...(pantry !== null && pantry.mode !== "ignore"
          ? {
              pantry: {
                mode: pantry.mode,
                items: pantry.stock.map(pantryText),
                staples: pantry.staples
              }
            }
          : {})
      }),
      tierHint: "reasoning"
    });
    if (!written.ok) return fail(written.error);
    let draft: RecipeDraft;
    try {
      draft = parseRecipe(written.object, { cookTimeLimitMinutes: request.cookTimeLimitMinutes });
    } catch {
      return fail("validation_failed");
    }
    draft = { ...draft, ingredients: applyBrandRule(draft.ingredients) };

    const key = titleKey(draft.title);
    if (!plan.allowRepeats && isRepeat(key, request.recentKeys)) continue;
    if (request.vetoedKeys?.has(key) === true) {
      lastRejection = "veto";
      continue;
    }

    // Cook only from on hand: a recipe that needs anything else is rejected and rewritten.
    if (pantry?.mode === "only" && offPantry(draft.ingredients, pantry).length > 0) {
      lastRejection = "pantry";
      continue;
    }

    const checked = await checkSafety(deps, draft, restrictions);
    if (checked.kind === "error") return fail(checked.reason);
    if (checked.verdicts.some((verdict) => verdict.verdict === "fail")) {
      lastVerdicts = checked.verdicts;
      lastRejection = "safety";
      continue;
    }
    return { ok: true, draft, key, verdicts: checked.verdicts, attempts };
  }
  // Running out of tries on the Pantry or on a one-star rule is not a Never serve problem, so it
  // says so.
  return fail(lastRejection === "safety" ? "safety_cap" : "validation_failed");
}
