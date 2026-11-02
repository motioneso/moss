// external-modules/meals/src/web/log-format.ts
//
// Display helpers for the Log. Times show in the offset stored with each meal, so a meal keeps
// the clock time it was eaten at.
import type { LogEntryView, NutrientsView } from "../contracts";

export type Occasion = "breakfast" | "lunch" | "dinner" | "snack";

export const OCCASIONS: ReadonlyArray<{ value: Occasion; label: string }> = [
  { value: "breakfast", label: "Breakfast" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
  { value: "snack", label: "Snack" }
];

function shifted(entry: Pick<LogEntryView, "consumedAt" | "timezoneOffset">): Date | null {
  const instant = new Date(entry.consumedAt);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() + entry.timezoneOffset * 60_000);
}

/** Breakfast 4 to 10, lunch 11 to 15, dinner 16 to 21, otherwise snack. */
export function occasionOf(entry: Pick<LogEntryView, "consumedAt" | "timezoneOffset">): Occasion {
  const local = shifted(entry);
  if (local === null) return "snack";
  const hour = local.getUTCHours();
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

/** "HH:MM" on a 24 hour clock, for a time input. */
export function timeValue(entry: Pick<LogEntryView, "consumedAt" | "timezoneOffset">): string {
  const local = shifted(entry);
  if (local === null) return "12:00";
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** "12:30 PM" */
export function timeText(entry: Pick<LogEntryView, "consumedAt" | "timezoneOffset">): string {
  const [h, m] = timeValue(entry).split(":").map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The day before or after an ISO date. */
export function shiftDay(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** A whole number for calories and sodium, one decimal at most for grams. Null reads "-". */
export function amount(value: number | null, digits = 0): string {
  if (value === null) return "-";
  return String(Number(value.toFixed(digits)));
}

export function entryCalories(entry: LogEntryView): string {
  return entry.nutrients === null ? "-" : amount(entry.nutrients.caloriesKcal);
}

export type NutrientKey = keyof NutrientsView;
