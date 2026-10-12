export function readerSchedule(now: Date = new Date()): { targetTime: string; timezone: string } {
  const timezone = "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")!.value);
  const minute = Number(parts.find((part) => part.type === "minute")!.value);
  // At the day's first minute, use its start rather than yesterday's last minute.
  const target = Math.max(0, hour * 60 + minute - 1);
  const targetTime = `${String(Math.floor(target / 60)).padStart(2, "0")}:${String(target % 60).padStart(2, "0")}`;
  return { targetTime, timezone };
}
