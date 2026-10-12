import { isValidTimeZone, localDay } from "@moss/shared";
import { zonedClockParts } from "./locale-format.js";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTC instant for a plan-zone wall time on the plan day; null on bad input. */
export function localTimeToIso(day: string, time: string, timeZone: string): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const target = Date.parse(`${day}T${time}:00Z`);
  let guess = target;
  if (Number.isNaN(guess)) return null;
  for (let i = 0; i < 2; i++) {
    const parts = zonedClockParts(guess, timeZone);
    if (!parts) return null;
    const wallDay = localDay(new Date(guess), timeZone);
    const diff = target - Date.parse(`${wallDay}T${pad2(parts.hour)}:${pad2(parts.minute)}:00Z`);
    if (diff === 0) return new Date(guess).toISOString();
    guess += diff;
  }
  return new Date(guess).toISOString();
}
