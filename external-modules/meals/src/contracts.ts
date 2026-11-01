// external-modules/meals/src/contracts.ts
//
// Views shared by the worker and the page. Every read tool's outputSchema in jarvis.module.json
// must cover every field here, because the page sees only declared fields.

export type PantryMode = "ignore" | "prefer" | "only";
export type UnitsSystem = "us" | "metric";
export type Sharing = "shared" | "solo";
export type WriteStatus = "pending" | "writing" | "ready" | "failed";
export type StoreSection =
  | "produce"
  | "meat_fish"
  | "dairy_eggs"
  | "bakery"
  | "frozen"
  | "pantry"
  | "spices"
  | "drinks"
  | "household"
  | "other";
export type GenerationFailure =
  | "needs_config"
  | "provider_error"
  | "usage_limited"
  | "validation_failed"
  | "aborted"
  | "safety_cap"
  | "timeout"
  | "stopped";

export interface MacroTargets {
  readonly proteinG: number | null;
  readonly carbG: number | null;
  readonly fatG: number | null;
}
export interface MemberView {
  readonly memberId: string;
  readonly name: string;
  readonly isSelf: boolean;
  readonly linkedAccountEmail: string | null;
  readonly calorieTarget: number | null;
  readonly macroTargets: MacroTargets;
  readonly mealPattern: readonly string[];
  readonly restrictions: readonly string[];
  readonly preferences: readonly string[];
  readonly favouriteRecipeIds: readonly string[];
}
export interface SlotRuleView {
  readonly slotName: string;
  readonly soloWeekdays: readonly number[];
  readonly usualTime: string | null;
}
export interface KitchenView {
  readonly kitchenId: string;
  readonly unitsSystem: UnitsSystem;
  readonly defaultPantryMode: PantryMode;
  readonly members: readonly MemberView[];
  readonly slotRules: readonly SlotRuleView[];
}

export interface CalorieFit {
  readonly targetKcal: number;
  readonly estimatedKcal: number;
  readonly band: "under" | "on" | "over";
  readonly differenceKcal: number;
}
export interface EaterView {
  readonly memberId: string;
  readonly name: string;
  readonly portion: number;
  readonly safety: "pending" | "pass" | "fail";
  readonly safetyReason: string | null;
  readonly fit: CalorieFit | null;
}
export interface PlannedMealView {
  readonly mealId: string;
  readonly slotName: string;
  readonly kind: "recipe" | "text";
  readonly sharing: Sharing;
  readonly status: WriteStatus;
  readonly failureReason: GenerationFailure | null;
  readonly locked: boolean;
  readonly oneOffFor: string | null;
  readonly favouriteOf: string | null;
  readonly title: string | null;
  readonly plainText: string | null;
  readonly cookMinutes: number | null;
  readonly servings: number;
  readonly eaters: readonly EaterView[];
  readonly checkLabelCount: number;
  readonly cookedAt: string | null;
}
export interface PlanDayView {
  readonly dayId: string;
  readonly date: string;
  readonly status: WriteStatus;
  readonly failureReason: GenerationFailure | null;
  readonly cookTimeLimitMinutes: number | null;
  readonly meals: readonly PlannedMealView[];
  readonly dayFit: readonly { readonly memberId: string; readonly fit: CalorieFit }[];
}
export interface PlanView {
  readonly planId: string;
  readonly startDate: string;
  readonly dayCount: number;
  readonly pantryMode: PantryMode;
  readonly state: "active" | "stopped" | "paused";
  readonly pausedReason: "invocation" | "pending" | "hourly" | null;
  readonly progress: { readonly ready: number; readonly total: number };
  readonly days: readonly PlanDayView[];
}
export interface IngredientView {
  readonly originalText: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly display: string | null;
  readonly section: StoreSection;
  readonly checkLabel: boolean;
  readonly missing: boolean;
}
export interface SwapChoiceView {
  readonly choiceId: string;
  readonly status: WriteStatus;
  readonly title: string | null;
  readonly cookMinutes: number | null;
  readonly eaters: readonly EaterView[];
}
export interface RecipeView {
  readonly meal: PlannedMealView;
  readonly recipeId: string | null;
  readonly baseServings: number | null;
  readonly servingsOverride: number | null;
  readonly steps: readonly string[];
  readonly ingredients: readonly IngredientView[];
  readonly swapChoices: readonly SwapChoiceView[];
}

export interface ListLineView {
  readonly lineId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly purchase: { readonly quantity: number; readonly unit: string } | null;
  readonly section: StoreSection;
  readonly manual: boolean;
  readonly coveredByPantry: boolean;
  readonly notInPlan: boolean;
  readonly convertedFrom: readonly string[];
  readonly sources: readonly { readonly mealId: string; readonly label: string }[];
  readonly checkedAt: string | null;
  readonly boughtAt: string | null;
}
export interface ShoppingListView {
  readonly listId: string;
  readonly planId: string | null;
  readonly pantryMode: PantryMode;
  readonly lines: readonly ListLineView[];
}
export interface PantryItemView {
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly source: "manual" | "bought" | "leftover" | "receipt";
  readonly updatedAt: string;
}
export interface StapleView {
  readonly stapleId: string;
  readonly name: string;
}
export interface PantryView {
  readonly items: readonly PantryItemView[];
  readonly staples: readonly StapleView[];
}

export interface UndoToken {
  readonly actionId: string;
  readonly kind: "bought" | "cooked" | "removed";
  readonly count: number;
}
export interface ListEditResult {
  readonly list: ShoppingListView;
  readonly undo: UndoToken | null;
}
export interface BoughtResult {
  readonly list: ShoppingListView;
  readonly pantryAdded: number;
  readonly undo: UndoToken;
}
export interface PantryEditResult {
  readonly pantry: PantryView;
  readonly undo: UndoToken | null;
}
export interface UndoResult {
  readonly restored: number;
  readonly skipped: number;
}
export interface CookedResult {
  readonly meal: PlannedMealView;
  readonly pantryChanges: readonly {
    readonly name: string;
    readonly before: number | null;
    readonly after: number | null;
    readonly unit: string | null;
  }[];
  readonly undo: UndoToken;
  readonly logOffer: { readonly description: string; readonly servingNote: string } | null;
}
