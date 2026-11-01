// external-modules/meals/src/log/domain.ts
//
// Pure log rules copied from Food: day totals, the occasion an entry belongs to, and the
// local-day and timestamp parsing. Nothing here touches the database or a model.
import { resolveLocalDay, strictLocalWallClockToInstant } from "@moss/module-sdk/time";

import type { LogEntryView, LogTotalsView, NutrientsView } from "../contracts.js";

const NUTRIENT_KEYS = [
  "caloriesKcal",
  "proteinG",
  "carbohydratesG",
  "fatG",
  "fiberG",
  "sugarG",
  "sodiumMg"
] as const satisfies readonly (keyof NutrientsView)[];

/**
 * Sums only entries whose estimate is complete. A nutrient total is null unless at least one
 * estimated entry contributed a number for it, so a half-estimated day never reads as a light
 * day. Any other entry flips `incomplete` and is counted, but adds nothing. The date is passed in
 * so an empty day still names its date.
 */
export function computeDayTotals(
  localDate: string,
  entries: readonly LogEntryView[]
): LogTotalsView {
  const sums: Record<keyof NutrientsView, number> = {
    caloriesKcal: 0,
    proteinG: 0,
    carbohydratesG: 0,
    fatG: 0,
    fiberG: 0,
    sugarG: 0,
    sodiumMg: 0
  };
  const contributed: Record<keyof NutrientsView, boolean> = {
    caloriesKcal: false,
    proteinG: false,
    carbohydratesG: false,
    fatG: false,
    fiberG: false,
    sugarG: false,
    sodiumMg: false
  };
  let entriesWithoutEstimate = 0;

  for (const entry of entries) {
    if (entry.estimateState !== "estimated" || entry.nutrients === null) {
      entriesWithoutEstimate += 1;
      continue;
    }
    for (const key of NUTRIENT_KEYS) {
      const value = entry.nutrients[key];
      if (value === null) continue;
      sums[key] += value;
      contributed[key] = true;
    }
  }

  const nutrients = Object.fromEntries(
    NUTRIENT_KEYS.map((key) => [key, contributed[key] ? sums[key] : null])
  ) as unknown as NutrientsView;
  return { localDate, nutrients, incomplete: entriesWithoutEstimate > 0, entriesWithoutEstimate };
}

export type Occasion = "breakfast" | "lunch" | "dinner" | "snack";

export const OCCASION_ORDER: readonly Occasion[] = ["breakfast", "lunch", "dinner", "snack"];

export const OCCASION_LABEL: Record<Occasion, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack"
};

/**
 * Which part of the day an entry belongs to, from the hour in the entry's own stored offset.
 * 04:00 to 10:59 breakfast, 11:00 to 15:59 lunch, 16:00 to 21:59 dinner, the rest snack. An
 * unreadable timestamp lands in snack so one bad row cannot blank the day.
 */
export function occasionForEntry(consumedAt: string, timezoneOffsetMinutes: number): Occasion {
  const instant = new Date(consumedAt);
  if (Number.isNaN(instant.getTime())) return "snack";
  const hour = new Date(instant.getTime() + timezoneOffsetMinutes * 60_000).getUTCHours();
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ISO_OFFSET_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:Z|[+-]\d{2}:\d{2})$/;

function hasValidCalendarParts(raw: string): boolean {
  const match = ISO_DATE_TIME_PATTERN.exec(raw.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ""));
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const maxDay = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  return (
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <= maxDay &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59)
  );
}

/**
 * Parses an exact ISO instant, or an offset-less local date-time in the given zone through the
 * SDK's strict DST-aware conversion.
 */
export function parseConsumedAtInstant(raw: string, effectiveZone: string): Date {
  if (ISO_OFFSET_PATTERN.test(raw)) {
    const parsed = new Date(raw);
    if (!hasValidCalendarParts(raw) || Number.isNaN(parsed.getTime())) {
      throw new Error("consumedAt must be a valid ISO instant");
    }
    return parsed;
  }
  if (ISO_DATE_TIME_PATTERN.test(raw)) {
    return strictLocalWallClockToInstant(raw, effectiveZone);
  }
  throw new Error("consumedAt must be an ISO instant or offset-less local date-time");
}

/**
 * The calendar day and UTC offset an entry is pinned to when it is created. Both are stored and
 * never recomputed on read, so a later change of time zone cannot move a past entry to another day.
 */
export function resolveEntryLocalDate(
  consumedAt: Date,
  timeZone: string
): { readonly localDate: string; readonly timezoneOffset: number } {
  const { localDate, timezoneOffsetMinutes } = resolveLocalDay(consumedAt, timeZone);
  return { localDate, timezoneOffset: timezoneOffsetMinutes };
}

/** An entry's nutrients are the sum of its items. Null stays null, never zero. */
export { sumItemNutrients } from "../estimator/nutrients.js";
