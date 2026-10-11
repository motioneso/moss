// #3150: code-written wording for clock-time reminders, in the owner's own clock format.

import { addLocalDays } from "@moss/module-sdk";
import type { LocaleDateFormat } from "@moss/shared";

import type { LocalClockTime } from "./clock-recognizer.js";
import type { LocalClockRefusal, ResolvedLocalClock } from "./local-clock.js";

export interface ReminderLocale {
  readonly timeZone: string;
  readonly clockFormat: LocaleDateFormat;
}

function formatClock(time: LocalClockTime, clockFormat: LocaleDateFormat): string {
  const minute = String(time.minute).padStart(2, "0");
  if (clockFormat === "24") return `${String(time.hour).padStart(2, "0")}:${minute}`;
  const hour = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return `${hour}:${minute} ${time.hour < 12 ? "AM" : "PM"}`;
}

/** "today", "tomorrow" or "on Monday, October 12", for a `YYYY-MM-DD` date. */
export function dayPhrase(localDate: string, today: string): string {
  if (localDate === today) return "today";
  if (localDate === addLocalDays(today, 1)) return "tomorrow";
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(date);
  return `on ${label}`;
}

/** Splits a `YYYY-MM-DDTHH:mm` wall clock into its date and time. */
function splitWallClock(local: string): { localDate: string; time: LocalClockTime } {
  const [localDate = "", clock = "00:00"] = local.split("T");
  const [hour, minute] = clock.split(":").map(Number) as [number, number];
  return { localDate, time: { hour, minute } };
}

/** "today at 3:00 PM", with the date first so it reads naturally after "remind you". */
export function whenPhrase(local: string, today: string, clockFormat: LocaleDateFormat): string {
  const { localDate, time } = splitWallClock(local);
  return `${dayPhrase(localDate, today)} at ${formatClock(time, clockFormat)}`;
}

/** "4:00 PM", or "1:00 AM tomorrow" when the deadline falls on another day than the reminder. */
export function deadlinePhrase(
  localDeadline: string,
  localDue: string,
  today: string,
  clockFormat: LocaleDateFormat
): string {
  const deadline = splitWallClock(localDeadline);
  const time = formatClock(deadline.time, clockFormat);
  return deadline.localDate === splitWallClock(localDue).localDate
    ? time
    : `${time} ${dayPhrase(deadline.localDate, today)}`;
}

/** "Pacific Time", or the zone id when the platform has no plain name for it. */
function zoneName(timeZone: string, at: Date): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  return name === undefined || name.startsWith("GMT") ? timeZone : name;
}

/** The confirmation names the zone, so a wrong profile zone shows up before the reminder fires. */
export function reminderClockSavedReply(
  resolved: ResolvedLocalClock,
  text: string,
  today: string,
  clockFormat: LocaleDateFormat
): string {
  const when = whenPhrase(resolved.localDue, today, clockFormat);
  const saved = `Okay. I'll remind you ${when} ${zoneName(resolved.timeZone, resolved.dueAt)}: ${text}`;
  if (resolved.localDeadline === null) return saved;
  const by = deadlinePhrase(resolved.localDeadline, resolved.localDue, today, clockFormat);
  return `${saved}\nIf I can't send it by ${by}, I'll skip it.`;
}

export function reminderClockRefusedReply(
  refusal: LocalClockRefusal,
  today: string,
  clockFormat: LocaleDateFormat
): string {
  switch (refusal.reason) {
    case "time_passed": {
      const time = formatClock(refusal.time, clockFormat);
      return `It's already past ${time} today, so I didn't set anything. Say "tomorrow at ${time}" if you meant tomorrow.`;
    }
    case "dst_gap":
      return `The clocks go forward ${dayPhrase(refusal.localDate, today)}, so ${formatClock(refusal.time, clockFormat)} doesn't happen that day. I didn't set anything. Pick a time outside that hour.`;
    case "dst_fold":
      return `The clocks go back ${dayPhrase(refusal.localDate, today)}, so ${formatClock(refusal.time, clockFormat)} happens twice that day. I didn't set anything. Pick a time outside that hour.`;
    case "deadline_too_far":
      return "The deadline has to be within 12 hours after the reminder time, so I didn't set anything.";
  }
}
