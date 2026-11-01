// external-modules/meals/src/store/cooking-port.ts
//
// The cooking store contract: Mark cooked and its Undo, servings, ratings and favourites. The
// module database has no transactions, so a write that touches several tables is one statement.
// store/cooking.ts implements it in SQL; the handler tests implement it in memory.
import type { PantryChange } from "../domain/cooking.js";

/** Ratings and favourites keyed by `${memberId}:${recipeId}`. */
export interface Marks {
  readonly ratings: ReadonlyMap<string, number>;
  readonly favourites: ReadonlySet<string>;
}

export const markKey = (memberId: string, recipeId: string) => `${memberId}:${recipeId}`;

export interface CookedState {
  readonly mealId: string;
  /** The timestamp stamped on the meal and on every Pantry row Mark cooked changed. */
  readonly at: string;
  readonly changes: readonly PantryChange[];
}

export interface Veto {
  readonly memberId: string;
  readonly title: string;
  readonly titleKey: string;
}

export interface PlacedEater {
  readonly memberId: string;
  readonly safety: "pass" | "fail";
  readonly safetyReason: string | null;
  readonly estimatedKcal: number | null;
}

export interface CookingStore {
  readMarks(): Promise<Marks>;
  /**
   * Stamps a ready, not yet cooked meal as cooked, writes the Pantry changes and stores the Undo
   * record, in one statement. False when the meal is missing, not ready, or already cooked.
   */
  markCooked(input: {
    readonly actionId: string;
    readonly kitchenId: string;
    readonly state: CookedState;
  }): Promise<boolean>;
  /**
   * Reverses Mark cooked and marks the Undo record done. A Pantry row edited since is skipped.
   * Returns how many Pantry rows were put back.
   */
  undoCooked(actionId: string, state: CookedState): Promise<number>;
  /** Null clears the override. False when no such meal is visible. */
  setServings(mealId: string, servings: number | null): Promise<boolean>;
  /** Null stars removes the rating. */
  setRating(
    kitchenId: string,
    memberId: string,
    recipeId: string,
    stars: number | null
  ): Promise<void>;
  setFavourite(kitchenId: string, memberId: string, recipeId: string, on: boolean): Promise<void>;
  /** One-star ratings by the given members. */
  vetoes(memberIds: readonly string[]): Promise<readonly Veto[]>;
  /**
   * Puts an existing recipe into an unlocked meal as a ready meal, with the eaters' fresh Safety
   * verdicts. False when the meal is missing or locked.
   */
  placeRecipe(input: {
    readonly mealId: string;
    readonly recipeId: string;
    readonly favouriteOf: string;
    readonly eaters: readonly PlacedEater[];
  }): Promise<boolean>;
}
