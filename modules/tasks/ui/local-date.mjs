// Package port of shared/time.ts and locale/wall-time.ts. Differential checks
// compare these functions with the unchanged application date helpers.
let dayZone;
let dayFormatter;
export function localDay(value, timeZone = "UTC") {
  if (!value) return "";
  if (dayZone !== timeZone || !dayFormatter) {
    dayFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dayZone = timeZone;
  }
  return dayFormatter.format(new Date(value));
}

// Date inputs represent a day, stored at noon in the account's saved zone.
export function localNoon(day, timeZone = "UTC") {
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid task date");
  const target = Date.parse(`${day}T12:00:00Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  for (let i = 0; i < 2; i++) {
    const wallDay = localDay(guess, timeZone);
    const clock = formatter.format(new Date(guess));
    const diff = target - Date.parse(`${wallDay}T${clock}:00Z`);
    if (diff === 0) return new Date(guess).toISOString();
    guess += diff;
  }
  return new Date(guess).toISOString();
}
