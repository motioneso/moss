import { isCalendarDate } from "./values.js";

export type BillCadence = "once" | "weekly" | "fortnightly" | "monthly" | "yearly";
export interface BillSchedule {
  anchorDate: string;
  cadence: BillCadence;
  /** Inclusive last planned date. Stopping preserves earlier occurrences. */
  endDate?: string | null;
}
const dateParts = (day: string) => day.split("-").map(Number) as [number, number, number];
function utc(day: string): Date {
  const [year, month, date] = dateParts(day);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}
function dayString(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999) return null;
  const prefix = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  for (let candidate = day; candidate >= 28; candidate--) {
    const value = `${prefix}-${String(candidate).padStart(2, "0")}`;
    if (isCalendarDate(value)) return value;
  }
  return `${prefix}-${String(day).padStart(2, "0")}`;
}
/** Always derive from the original anchor: a February clamp must not move March's date. */
export function billOccurrence(schedule: BillSchedule, index: number): string | null {
  if (
    !isCalendarDate(schedule.anchorDate) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 3_652_058
  )
    throw new Error("Invalid bill schedule or occurrence index");
  if (
    schedule.endDate &&
    (!isCalendarDate(schedule.endDate) || schedule.endDate < schedule.anchorDate)
  )
    throw new Error("Invalid bill end date");
  const [year, month, day] = dateParts(schedule.anchorDate);
  let result: string | null;
  switch (schedule.cadence) {
    case "once":
      result = index === 0 ? schedule.anchorDate : null;
      break;
    case "weekly":
    case "fortnightly": {
      const date = utc(schedule.anchorDate);
      date.setUTCDate(date.getUTCDate() + index * (schedule.cadence === "weekly" ? 7 : 14));
      result = date.getUTCFullYear() > 9999 ? null : date.toISOString().slice(0, 10);
      break;
    }
    case "monthly": {
      const absolute = year * 12 + month - 1 + index;
      result = dayString(Math.floor(absolute / 12), (absolute % 12) + 1, day);
      break;
    }
    case "yearly":
      result = dayString(year + index, month, day);
      break;
    default:
      throw new Error("Unsupported bill cadence");
  }
  return result && (!schedule.endDate || result <= schedule.endDate) ? result : null;
}
/** Bounded projections only: no transaction is posted and no local-time arithmetic is used. */
export function billOccurrences(schedule: BillSchedule, from: string, to: string): string[] {
  if (
    !isCalendarDate(from) ||
    !isCalendarDate(to) ||
    from > to ||
    utc(to).getTime() - utc(from).getTime() > 366 * 86400000
  )
    throw new Error("Choose a bill projection window of at most one year");
  billOccurrence(schedule, 0);
  const [year, month] = dateParts(schedule.anchorDate);
  const [fromYear, fromMonth] = dateParts(from);
  const days = Math.floor((utc(from).getTime() - utc(schedule.anchorDate).getTime()) / 86400000);
  let index = Math.max(
    0,
    schedule.cadence === "monthly"
      ? (fromYear - year) * 12 + fromMonth - month
      : schedule.cadence === "yearly"
        ? fromYear - year
        : schedule.cadence === "once"
          ? 0
          : Math.floor(days / (schedule.cadence === "weekly" ? 7 : 14))
  );
  const result: string[] = [];
  for (let count = 0; count < 55; count++, index++) {
    const occurrence = billOccurrence(schedule, index);
    if (!occurrence || occurrence > to) break;
    if (occurrence >= from) result.push(occurrence);
  }
  return result;
}
