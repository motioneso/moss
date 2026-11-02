// tests/unit/helpers/meals-cooking-fake.ts
//
// Meals S10 (#3894): an in-memory CookingStore over the fake plan and Pantry stores. It follows
// the SQL store's rules: Mark cooked stamps the meal and the changed Pantry rows with one
// timestamp and stores an Undo record, and Undo skips a Pantry row edited since.
import type { UndoRecord } from "../../../external-modules/meals/src/store/list-port.js";
import {
  markKey,
  type CookedState,
  type CookingStore,
  type Marks,
  type PlacedEater,
  type Veto
} from "../../../external-modules/meals/src/store/cooking-port.js";
import type { FakePantryStore } from "./meals-pantry-fake.js";
import type { FakePlanStore } from "./meals-plan-fake.js";

export class FakeCookingStore implements CookingStore {
  readonly ratings = new Map<string, number>();
  readonly favourites = new Set<string>();
  readonly placed: { mealId: string; recipeId: string; eaters: readonly PlacedEater[] }[] = [];

  constructor(
    private readonly plans: FakePlanStore,
    private readonly pantry: FakePantryStore,
    private readonly undos: Map<string, UndoRecord>
  ) {}

  async readMarks(): Promise<Marks> {
    return { ratings: new Map(this.ratings), favourites: new Set(this.favourites) };
  }

  async markCooked(input: { actionId: string; kitchenId: string; state: CookedState }) {
    const meal = this.plans.meals.get(input.state.mealId);
    if (!meal || meal.cookedAt !== null || meal.status !== "ready") return false;
    meal.cookedAt = input.state.at;
    for (const change of input.state.changes) {
      const item = this.pantry.items.get(change.itemId);
      if (item)
        this.pantry.items.set(change.itemId, {
          ...item,
          quantity: change.after,
          updatedAt: input.state.at
        });
    }
    this.undos.set(input.actionId, {
      actionId: input.actionId,
      kind: "cooked",
      state: { ...input.state },
      undone: false
    });
    return true;
  }

  async undoCooked(actionId: string, state: CookedState) {
    const record = this.undos.get(actionId);
    if (!record || record.undone) return 0;
    this.undos.set(actionId, { ...record, undone: true });
    const meal = this.plans.meals.get(state.mealId);
    if (meal && meal.cookedAt === state.at) meal.cookedAt = null;
    let restored = 0;
    for (const change of state.changes) {
      const item = this.pantry.items.get(change.itemId);
      if (item && item.updatedAt === state.at) {
        this.pantry.items.set(change.itemId, { ...item, quantity: change.before });
        restored += 1;
      }
    }
    return restored;
  }

  async setServings(mealId: string, servings: number | null) {
    const meal = this.plans.meals.get(mealId);
    if (!meal) return false;
    meal.servingsOverride = servings;
    return true;
  }

  async setRating(_kitchenId: string, memberId: string, recipeId: string, stars: number | null) {
    const key = markKey(memberId, recipeId);
    if (stars === null) this.ratings.delete(key);
    else this.ratings.set(key, stars);
  }

  async setFavourite(_kitchenId: string, memberId: string, recipeId: string, on: boolean) {
    const key = markKey(memberId, recipeId);
    if (on) this.favourites.add(key);
    else this.favourites.delete(key);
  }

  async vetoes(memberIds: readonly string[]): Promise<readonly Veto[]> {
    const out: Veto[] = [];
    for (const [key, stars] of this.ratings) {
      const [memberId, recipeId] = key.split(":") as [string, string];
      const recipe = this.plans.recipes.get(recipeId);
      if (stars === 1 && memberIds.includes(memberId) && recipe) {
        out.push({ memberId, title: recipe.title, titleKey: recipe.titleKey });
      }
    }
    return out;
  }

  async placeRecipe(input: {
    mealId: string;
    recipeId: string;
    favouriteOf: string;
    eaters: readonly PlacedEater[];
  }) {
    const meal = this.plans.meals.get(input.mealId);
    if (!meal || meal.locked) return false;
    Object.assign(meal, {
      recipeId: input.recipeId,
      kind: "recipe",
      status: "ready",
      favouriteOf: input.favouriteOf,
      servingsOverride: null,
      cookedAt: null
    });
    this.placed.push({ mealId: input.mealId, recipeId: input.recipeId, eaters: input.eaters });
    return true;
  }
}
