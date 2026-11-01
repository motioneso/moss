// external-modules/meals/src/cooking/tools.ts
//
// The meals.meal.cooked, meals.meal.servings, meals.meal.rate and meals.favourites.edit handlers.
// Mark cooked takes what the meal used out of the Pantry and returns an Undo token plus an offer
// to log a portion; it never logs by itself, so the estimate job runs through meals.log.add.
import { buildSafetyPrompt, parseSafety, SAFETY_SCHEMA } from "../ai/safety.js";
import type { CookedResult, KitchenView, PlannedMealView, RecipeView } from "../contracts.js";
import { pantrySubtraction, validServings } from "../domain/cooking.js";
import { deterministicSafety, mergeSafety, type SafetyVerdict } from "../domain/safety.js";
import type { PlanDeps } from "../plans/deps.js";
import { mealGet } from "../plans/tools.js";
import type { CookingStore } from "../store/cooking-port.js";
import { markKey } from "../store/cooking-port.js";
import type { PantryStore } from "../store/pantry-port.js";
import type { MealRow, RecipeRow } from "../store/plan-port.js";
import { InputError, readEnum, readUuid, requireNoUnknownKeys } from "../tools/validate.js";

type Input = Record<string, unknown>;

export type CookingDeps = PlanDeps & {
  readonly pantry: PantryStore;
  readonly cooking: CookingStore;
  readonly now: () => Date;
  /** Called after Mark cooked or its Undo changes the Pantry, so the list can rebuild. */
  readonly onPantryChange?: () => Promise<void>;
};

const NO_MEAL = "There is no meal with that id";
const NO_RECIPE = "That meal has no recipe yet";

async function recipeMeal(
  deps: CookingDeps,
  mealId: string
): Promise<{ meal: MealRow & { planId: string }; recipe: RecipeRow }> {
  const meal = await deps.store.getMeal(mealId);
  if (meal === null) throw new InputError(NO_MEAL);
  if (meal.kind !== "recipe" || meal.status !== "ready" || meal.recipeId === null) {
    throw new InputError(NO_RECIPE);
  }
  const recipe = (await deps.store.getRecipes([meal.recipeId]))[0];
  if (recipe === undefined) throw new InputError(NO_RECIPE);
  return { meal, recipe };
}

function servingsOf(meal: MealRow, recipe: RecipeRow): number {
  const eaten = meal.eaters.reduce((sum, eater) => sum + eater.portion, 0);
  return meal.servingsOverride ?? (eaten > 0 ? eaten : recipe.baseServings);
}

const view = async (deps: CookingDeps, mealId: string): Promise<PlannedMealView> =>
  (await mealGet(deps, { mealId })).meal;

const COOKED_KEYS = new Set(["mealId"]);

export async function mealCooked(deps: CookingDeps, input: Input): Promise<CookedResult> {
  requireNoUnknownKeys(input, COOKED_KEYS);
  const mealId = readUuid(input, "mealId", { required: true });
  const { meal, recipe } = await recipeMeal(deps, mealId);
  if (meal.cookedAt !== null) throw new InputError("That meal is already marked cooked");

  const [stock, staples, kitchen] = await Promise.all([
    deps.pantry.readItems(),
    deps.pantry.readStaples(),
    deps.ensureKitchen()
  ]);
  const servings = servingsOf(meal, recipe);
  const changes = pantrySubtraction(recipe.ingredients, servings / recipe.baseServings, stock, {
    mode: "prefer",
    stock: [],
    staples: staples.map((staple) => staple.name)
  });
  const actionId = deps.newId();
  const at = deps.now().toISOString();
  const marked = await deps.cooking.markCooked({
    actionId,
    kitchenId: kitchen.kitchenId,
    state: { mealId, at, changes }
  });
  if (!marked) throw new InputError("That meal is already marked cooked");
  if (changes.length > 0) await deps.onPantryChange?.();

  const self = kitchen.members.find((person) => person.isSelf);
  const portion = meal.eaters.find((eater) => eater.memberId === self?.memberId)?.portion;
  return {
    meal: await view(deps, mealId),
    pantryChanges: changes.map((change) => ({
      name: change.name,
      before: change.before,
      after: change.after,
      unit: change.unit
    })),
    undo: { actionId, kind: "cooked", count: changes.length },
    logOffer:
      portion === undefined
        ? null
        : {
            description: recipe.title,
            servingNote: portion === 1 ? "1 serving" : `${portion} servings`
          }
  };
}

const SERVINGS_KEYS = new Set(["mealId", "servings"]);

export async function mealServings(deps: CookingDeps, input: Input): Promise<RecipeView> {
  requireNoUnknownKeys(input, SERVINGS_KEYS);
  const mealId = readUuid(input, "mealId", { required: true });
  const raw = input["servings"];
  if (raw !== null && (typeof raw !== "number" || !validServings(raw))) {
    throw new InputError("servings must be a multiple of 0.5 from 0.5 to 24, or null to reset");
  }
  const { meal } = await recipeMeal(deps, mealId);
  if (meal.cookedAt !== null) throw new InputError("That meal is already cooked");
  await deps.cooking.setServings(mealId, raw);
  await deps.onPlanChange?.(meal.planId, "written");
  return mealGet(deps, { mealId });
}

const RATE_KEYS = new Set(["mealId", "ratings"]);

export async function mealRate(deps: CookingDeps, input: Input): Promise<RecipeView> {
  requireNoUnknownKeys(input, RATE_KEYS);
  const mealId = readUuid(input, "mealId", { required: true });
  const list = input["ratings"];
  if (!Array.isArray(list) || list.length === 0 || list.length > 20) {
    throw new InputError("ratings must list 1 to 20 people with their stars");
  }
  const { meal } = await recipeMeal(deps, mealId);
  const kitchen = await deps.ensureKitchen();
  const people = new Set(kitchen.members.map((person) => person.memberId));
  const parsed = list.map((entry: unknown) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const memberId = readUuid(item, "memberId", { required: true });
    const stars = item["stars"];
    if (
      stars !== null &&
      (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5)
    ) {
      throw new InputError("stars must be a whole number from 1 to 5, or null to clear");
    }
    if (!people.has(memberId)) throw new InputError("There is no household member with that id");
    return { memberId, stars: stars as number | null };
  });
  for (const rating of parsed) {
    await deps.cooking.setRating(kitchen.kitchenId, rating.memberId, meal.recipeId!, rating.stars);
  }
  return mealGet(deps, { mealId });
}

const FAVOURITE_KEYS = new Set(["action", "memberId", "recipeId", "mealId"]);
const FAVOURITE_ACTIONS = ["add", "remove", "place"] as const;

async function safetyFor(
  deps: CookingDeps,
  recipe: RecipeRow,
  meal: MealRow,
  kitchen: KitchenView
): Promise<readonly SafetyVerdict[]> {
  const people = meal.eaters.map((eater) =>
    kitchen.members.find((person) => person.memberId === eater.memberId)
  );
  const restrictions = (index: number) => people[index]?.restrictions ?? [];
  const rule = meal.eaters.map((_, index) =>
    deterministicSafety(recipe.ingredients, restrictions(index))
  );
  const judged = await deps.ai.generateStructured({
    schema: SAFETY_SCHEMA,
    prompt: buildSafetyPrompt(
      {
        title: recipe.title,
        steps: recipe.steps,
        cookMinutes: recipe.cookMinutes,
        baseServings: recipe.baseServings,
        ingredients: recipe.ingredients
      },
      meal.eaters.map((_, index) => ({ restrictions: restrictions(index) }))
    ),
    tierHint: "reasoning"
  });
  if (!judged.ok) throw new InputError("The Safety check could not run, so nothing was placed");
  let model: readonly SafetyVerdict[];
  try {
    model = parseSafety(judged.object, meal.eaters.length);
  } catch {
    throw new InputError("The Safety check could not run, so nothing was placed");
  }
  return rule.map((verdict, index) => mergeSafety(verdict, model[index] ?? null));
}

export async function favouritesEdit(
  deps: CookingDeps,
  input: Input
): Promise<{ readonly kitchen: KitchenView; readonly meal: PlannedMealView | null }> {
  requireNoUnknownKeys(input, FAVOURITE_KEYS);
  const action = readEnum(input, "action", FAVOURITE_ACTIONS, { required: true });
  const memberId = readUuid(input, "memberId", { required: true });
  const recipeId = readUuid(input, "recipeId", { required: true });
  const kitchen = await deps.ensureKitchen();
  if (!kitchen.members.some((person) => person.memberId === memberId)) {
    throw new InputError("There is no household member with that id");
  }
  if ((await deps.store.getRecipes([recipeId])).length === 0) {
    throw new InputError("There is no recipe with that id");
  }
  if (action !== "place") {
    await deps.cooking.setFavourite(kitchen.kitchenId, memberId, recipeId, action === "add");
    return { kitchen: await deps.kitchen(), meal: null };
  }

  const mealId = readUuid(input, "mealId", { required: true });
  const marks = await deps.cooking.readMarks();
  if (!marks.favourites.has(markKey(memberId, recipeId))) {
    throw new InputError("That recipe is not one of this person's favourites");
  }
  const meal = await deps.store.getMeal(mealId);
  if (meal === null) throw new InputError(NO_MEAL);
  if (meal.locked) throw new InputError("That meal is locked. Unlock it to place a favourite");
  if (meal.cookedAt !== null) throw new InputError("That meal is already cooked");
  if (!meal.eaters.some((eater) => eater.memberId === memberId)) {
    throw new InputError("That person does not eat this meal");
  }
  const recipe = (await deps.store.getRecipes([recipeId]))[0]!;
  const verdicts = await safetyFor(deps, recipe, meal, kitchen);
  const failed = verdicts.findIndex((verdict) => verdict.verdict === "fail");
  if (failed >= 0) {
    const name =
      kitchen.members.find((person) => person.memberId === meal.eaters[failed]!.memberId)?.name ??
      "Someone";
    const verdict = verdicts[failed]!;
    throw new InputError(
      `Not placed. ${name}: ${verdict.verdict === "fail" ? verdict.reason : "failed the Safety check"}`
    );
  }
  const placed = await deps.cooking.placeRecipe({
    mealId,
    recipeId,
    favouriteOf: memberId,
    eaters: meal.eaters.map((eater) => ({
      memberId: eater.memberId,
      safety: "pass" as const,
      safetyReason: null,
      estimatedKcal:
        recipe.kcalPerServing === null ? null : Math.round(recipe.kcalPerServing * eater.portion)
    }))
  });
  if (!placed) throw new InputError("That meal is locked. Unlock it to place a favourite");
  await deps.onPlanChange?.(meal.planId, "written");
  return { kitchen: await deps.kitchen(), meal: await view(deps, mealId) };
}
