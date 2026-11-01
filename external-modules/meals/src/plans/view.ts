// external-modules/meals/src/plans/view.ts
//
// Builds PlanView and RecipeView from store rows and the kitchen. Pure, so the views read the
// same from the SQL store and the in-memory one.

import type {
  CalorieFit,
  EaterView,
  IngredientView,
  KitchenView,
  MemberView,
  PlanDayView,
  PlannedMealView,
  PlanView,
  RecipeView,
  SwapChoiceView
} from "../contracts.js";
import { isReplaceable } from "../domain/regenerate.js";
import { calorieFit, mealShareKcal, portionFor } from "../domain/targets.js";
import { markKey, type Marks } from "../store/cooking-port.js";
import type {
  DayRow,
  MealRow,
  PlanRow,
  RecipeRow,
  SwapChoiceRow
} from "../store/plan-port.js";

const REMOVED_MEMBER = "Removed member";

const NO_MARKS: Marks = { ratings: new Map(), favourites: new Set() };

function eaterView(
  eater: MealRow["eaters"][number],
  slotName: string,
  members: Map<string, MemberView>,
  recipeId: string | null,
  marks: Marks
): EaterView {
  const person = members.get(eater.memberId);
  const share = person ? mealShareKcal(person, slotName) : null;
  return {
    memberId: eater.memberId,
    name: person?.name ?? REMOVED_MEMBER,
    portion: eater.portion,
    safety: eater.safety,
    safetyReason: eater.safetyReason,
    fit:
      share !== null && eater.estimatedKcal !== null
        ? calorieFit(share, eater.estimatedKcal)
        : null,
    rating: recipeId ? (marks.ratings.get(markKey(eater.memberId, recipeId)) ?? null) : null,
    favourite: recipeId ? marks.favourites.has(markKey(eater.memberId, recipeId)) : false
  };
}

export function mealView(
  meal: MealRow,
  recipe: RecipeRow | undefined,
  members: Map<string, MemberView>,
  marks: Marks = NO_MARKS
): PlannedMealView {
  const eaters = meal.eaters.map((eater) =>
    eaterView(eater, meal.slotName, members, meal.recipeId, marks)
  );
  const servings = meal.servingsOverride ?? eaters.reduce((sum, eater) => sum + eater.portion, 0);
  return {
    mealId: meal.mealId,
    slotName: meal.slotName,
    kind: meal.kind,
    sharing: meal.sharing,
    status: meal.status,
    failureReason: meal.failureReason,
    locked: meal.locked,
    oneOffFor: meal.oneOffFor,
    favouriteOf: meal.favouriteOf,
    title: recipe?.title ?? null,
    plainText: meal.plainText,
    cookMinutes: recipe?.cookMinutes ?? null,
    servings,
    eaters,
    checkLabelCount: recipe?.ingredients.filter((line) => line.checkLabel).length ?? 0,
    cookedAt: meal.cookedAt
  };
}

/** A member's day total against their target, once every meal they eat that day has an estimate. */
function dayFit(meals: readonly PlannedMealView[], members: Map<string, MemberView>) {
  const totals = new Map<string, { kcal: number; complete: boolean }>();
  for (const meal of meals) {
    for (const eater of meal.eaters) {
      const total = totals.get(eater.memberId) ?? { kcal: 0, complete: true };
      if (meal.status !== "ready" || eater.fit === null) total.complete = false;
      else total.kcal += eater.fit.estimatedKcal;
      totals.set(eater.memberId, total);
    }
  }
  const fits: { memberId: string; fit: CalorieFit }[] = [];
  for (const [memberId, total] of totals) {
    const target = members.get(memberId)?.calorieTarget ?? null;
    if (target !== null && total.complete)
      fits.push({ memberId, fit: calorieFit(target, total.kcal) });
  }
  return fits;
}

export function membersById(kitchen: KitchenView): Map<string, MemberView> {
  return new Map(kitchen.members.map((person) => [person.memberId, person]));
}

export function planView(
  plan: PlanRow,
  days: readonly DayRow[],
  meals: readonly MealRow[],
  recipes: readonly RecipeRow[],
  kitchen: KitchenView,
  marks: Marks = NO_MARKS
): PlanView {
  const members = membersById(kitchen);
  const recipeById = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));
  const dayViews: PlanDayView[] = days.map((day) => {
    const dayMeals = meals
      .filter((meal) => meal.dayId === day.dayId)
      .map((meal) =>
        mealView(meal, meal.recipeId ? recipeById.get(meal.recipeId) : undefined, members, marks)
      );
    return {
      dayId: day.dayId,
      date: day.date,
      status: day.status,
      failureReason: day.failureReason,
      cookTimeLimitMinutes: day.cookTimeLimitMinutes,
      meals: dayMeals,
      dayFit: dayFit(dayMeals, members)
    };
  });
  return {
    planId: plan.planId,
    startDate: plan.startDate,
    dayCount: plan.dayCount,
    pantryMode: plan.pantryMode,
    state: plan.state,
    pausedReason: plan.pausedReason,
    progress: { ready: days.filter((day) => day.status === "ready").length, total: days.length },
    replaceable: meals.filter(isReplaceable).length,
    days: dayViews
  };
}

function formatAmount(quantity: number, unit: string | null): string {
  const rounded = Math.round(quantity * 100) / 100;
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

export function recipeView(
  meal: MealRow,
  recipe: RecipeRow | undefined,
  kitchen: KitchenView,
  marks: Marks = NO_MARKS,
  swapChoices: readonly SwapChoiceView[] = []
): RecipeView {
  const view = mealView(meal, recipe, membersById(kitchen), marks);
  const scale = recipe ? view.servings / recipe.baseServings : 1;
  const ingredients: IngredientView[] = (recipe?.ingredients ?? []).map((line) => ({
    originalText: line.originalText,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    display: line.quantity === null ? null : formatAmount(line.quantity * scale, line.unit),
    section: line.section,
    checkLabel: line.checkLabel,
    missing: false
  }));
  return {
    meal: view,
    recipeId: recipe?.recipeId ?? null,
    baseServings: recipe?.baseServings ?? null,
    servingsOverride: meal.servingsOverride,
    steps: recipe?.steps ?? [],
    ingredients,
    swapChoices
  };
}

/** Eater rows for a swap choice, sized from the choice's own calories. A shown choice passed Safety. */
export function eatersForRecipe(
  meal: MealRow,
  recipe: RecipeRow,
  members: Map<string, MemberView>
): MealRow["eaters"] {
  return meal.eaters.map((eater) => {
    const person = members.get(eater.memberId);
    const share = person ? mealShareKcal(person, meal.slotName) : null;
    const portion = portionFor(share, recipe.kcalPerServing);
    return {
      memberId: eater.memberId,
      portion,
      estimatedKcal:
        recipe.kcalPerServing === null ? null : Math.round(recipe.kcalPerServing * portion),
      safety: "pass" as const,
      safetyReason: null
    };
  });
}

export function swapChoiceViews(
  meal: MealRow,
  choices: readonly SwapChoiceRow[],
  recipes: readonly RecipeRow[],
  kitchen: KitchenView
): SwapChoiceView[] {
  const members = membersById(kitchen);
  const recipeById = new Map(recipes.map((recipe) => [recipe.recipeId, recipe]));
  return [...choices]
    .sort((a, b) => a.position - b.position)
    .map((choice) => {
      const recipe = choice.recipeId ? recipeById.get(choice.recipeId) : undefined;
      const ready = choice.status === "ready" && recipe !== undefined;
      return {
        choiceId: choice.choiceId,
        status: choice.status,
        title: recipe?.title ?? null,
        cookMinutes: recipe?.cookMinutes ?? null,
        eaters: ready
          ? eatersForRecipe(meal, recipe, members).map((eater) =>
              eaterView(eater, meal.slotName, members)
            )
          : []
      };
    });
}
