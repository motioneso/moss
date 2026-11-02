// external-modules/meals/src/domain/replan.ts
//
// Pure rules for the mid-week re-plan and the quick swap. Which meals a re-plan may touch
// depends on the household's own clock, and what a quick swap still needs to buy depends on
// the Pantry as it is now. Both read records only, so the page and chat show the same answer.

import type { PantryView, PlanView, SlotRuleView } from "../contracts.js";
import type { IngredientDraft } from "./safety.js";
import { coverage, isStaple, type PantryInput } from "./pantry.js";
import { isReplaceable } from "./regenerate.js";

/** Today and the local time of day in a zone, as plain strings the plan dates compare with. */
function localParts(now: Date, timeZone: string): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`
  };
}

/**
 * The meals a mid-week re-plan replaces. Past days never change. A meal today stays once its
 * slot's usual time has passed, and a slot with no usual time can still be re-planned today.
 * Locked, cooked, text and unwritten meals stay, as they do for Regenerate.
 */
export function replanScope(
  plan: PlanView,
  now: Date,
  timeZone: string,
  rules: readonly SlotRuleView[]
): readonly string[] {
  const { date: today, time } = localParts(now, timeZone);
  const usual = new Map(rules.map((rule) => [rule.slotName, rule.usualTime]));
  const ids: string[] = [];
  for (const day of plan.days) {
    if (day.date < today) continue;
    for (const meal of day.meals) {
      if (!isReplaceable(meal)) continue;
      if (day.date === today) {
        const slotTime = usual.get(meal.slotName) ?? null;
        if (slotTime !== null && time > slotTime) continue;
      }
      ids.push(meal.mealId);
    }
  }
  return ids;
}

/** Names a recipe still needs to buy, because neither the Pantry nor the Staples cover them. */
export function missingFor(
  ingredients: readonly Pick<IngredientDraft, "name" | "quantity" | "unit">[],
  pantry: PantryView
): readonly string[] {
  const input: PantryInput = {
    mode: "prefer",
    stock: pantry.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit
    })),
    staples: pantry.staples.map((staple) => staple.name)
  };
  const missing: string[] = [];
  for (const ingredient of ingredients) {
    if (isStaple(ingredient.name, input)) continue;
    if (
      coverage(ingredient.name, ingredient.quantity, ingredient.unit, input.stock).kind ===
      "covered"
    ) {
      continue;
    }
    if (!missing.includes(ingredient.name)) missing.push(ingredient.name);
  }
  return missing;
}
