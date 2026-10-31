import { isCalendarMonth, isCalendarDate, safeCents } from "./values.js";
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;
export const MAX_WEEKLY_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / 5);
export interface WeeklyTargetPeriod {
  weekday: number;
  occurrences: number;
  totalCents: number;
}
/** Full calendar-month occurrences, independent of the machine timezone and current date. */
export function countWeekdays(month: string, weekday: number): number {
  if (!isCalendarMonth(month) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    throw new Error("Choose a valid month and weekday");
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  let days = 31;
  while (!isCalendarDate(`${month}-${days}`)) days--;
  const firstOccurrence = 1 + ((weekday - first + 7) % 7);
  return Math.floor((days - firstOccurrence) / 7) + 1;
}
export function weeklyTargetPeriod(
  month: string,
  weekday: number,
  amountCents: number
): WeeklyTargetPeriod {
  const amount = safeCents(amountCents);
  if (amount < 1 || amount > MAX_WEEKLY_CENTS)
    throw new Error("Choose a weekly amount that fits every full month safely");
  const occurrences = countWeekdays(month, weekday);
  return { weekday, occurrences, totalCents: safeCents(BigInt(amount) * BigInt(occurrences)) };
}
