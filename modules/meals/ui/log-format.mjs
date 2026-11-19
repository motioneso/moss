/** Display helpers for the Log. A meal keeps the clock time it was eaten at. */

export const OCCASIONS = [
  ["breakfast", "Breakfast"],
  ["lunch", "Lunch"],
  ["dinner", "Dinner"],
  ["snack", "Snack"]
];

function shifted(entry) {
  const instant = new Date(entry.consumedAt);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() + entry.timezoneOffset * 60_000);
}

/** Breakfast 4 to 10, lunch 11 to 15, dinner 16 to 21, otherwise snack. */
export function occasionOf(entry) {
  const local = shifted(entry);
  if (local === null) return "snack";
  const hour = local.getUTCHours();
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

/** "HH:MM" on a 24 hour clock, for a time input. */
export function timeValue(entry) {
  const local = shifted(entry);
  if (local === null) return "12:00";
  return `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** "12:30 PM" */
export function timeText(entry) {
  const [h, m] = timeValue(entry).split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The day before or after an ISO date. */
export function shiftDay(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** A whole number for calories, one decimal at most for grams. Null reads "-". */
export function amount(value, digits = 0) {
  if (value === null) return "-";
  return String(Number(value.toFixed(digits)));
}

export const entryCalories = (entry) =>
  entry.nutrients === null ? "-" : amount(entry.nutrients.caloriesKcal);
