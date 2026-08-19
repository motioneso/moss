// external-modules/food/src/domain/occasion.ts
//
// Food phase 2 (#1737, spec 2026-08-19 §Web, story 46): which occasion a meal
// belongs to — breakfast, lunch, dinner or snack. Derived from the time the
// meal was eaten; never asked for, never stored. A stored occasion would be a
// fourth thing to keep in sync with consumed_at, and would go stale the moment
// a correction moved the meal's time.
//
// Pure and offset-explicit so it is testable without a browser and without an
// ambient timezone: the hour comes from the meal's OWN persisted offset, the
// same rule the day view's clock formatting follows. Re-deriving it from the
// viewer's zone would file a 9pm dinner under breakfast for anyone reading the
// log from another continent.

/** Display grouping only. Not persisted, not part of any tool contract. */
export type Occasion = "breakfast" | "lunch" | "dinner" | "snack";

/** The order occasions appear down the day view, regardless of when meals landed. */
export const OCCASION_ORDER: readonly Occasion[] = ["breakfast", "lunch", "dinner", "snack"];

export const OCCASION_LABEL: Record<Occasion, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack"
};

/**
 * Boundaries, stated once here rather than scattered through the view:
 *
 * - 04:00-10:59 breakfast
 * - 11:00-15:59 lunch
 * - 16:00-21:59 dinner
 * - 22:00-03:59 snack
 *
 * "Snack" is the late-night and pre-dawn bucket as well as the catch-all — a
 * 2am meal is not breakfast, and calling it one would put it above lunch in a
 * day it belongs at the end of.
 *
 * An unparseable timestamp also lands in "snack" rather than throwing: this
 * runs while rendering a list, and one bad row must not blank the day.
 */
export function occasionForMeal(consumedAt: string, timezoneOffsetMinutes: number): Occasion {
  const instant = new Date(consumedAt);
  if (Number.isNaN(instant.getTime())) return "snack";
  const hour = new Date(instant.getTime() + timezoneOffsetMinutes * 60_000).getUTCHours();
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}
