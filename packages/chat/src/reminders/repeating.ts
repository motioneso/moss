import {
  addLocalDays,
  localDayKey,
  scheduledLocalWallClockToInstant,
  strictLocalWallClockToInstant
} from "@moss/module-sdk";
import type { LocaleDateFormat, ReminderRepeat } from "@moss/shared";
import { formatClock } from "./clock-wording.js";

export interface RepeatAnchor {
  readonly repeat: ReminderRepeat;
  readonly dueAt: Date;
  readonly localDue: string | null;
  readonly timeZone: string | null;
}

/** Saved cadence, rather than delivery time, determines the first future occurrence. */
export function nextReminderOccurrence(anchor: RepeatAnchor, now: Date) {
  if (anchor.repeat.kind === "interval") {
    const step = anchor.repeat.seconds * 1000;
    if (!Number.isInteger(step) || step < 60_000 || step >= 86_400_000)
      throw new Error("Invalid reminder interval");
    const missed = Math.max(1, Math.floor((now.getTime() - anchor.dueAt.getTime()) / step) + 1);
    return { dueAt: new Date(anchor.dueAt.getTime() + missed * step), localDue: null };
  }
  if (!anchor.localDue || !anchor.timeZone) throw new Error("Missing local reminder schedule");
  const stepDays = anchor.repeat.kind === "weekly" ? 7 : 1;
  const anchorDate = anchor.localDue.slice(0, 10);
  const today = localDayKey(now, anchor.timeZone);
  const days = Math.max(
    0,
    Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / 86_400_000
    )
  );
  let date = addLocalDays(anchorDate, Math.floor(days / stepDays) * stepDays);
  let localDue = `${date}${anchor.localDue.slice(10)}`;
  let dueAt = scheduledLocalWallClockToInstant(localDue, anchor.timeZone);
  if (dueAt <= now || dueAt <= anchor.dueAt) {
    date = addLocalDays(date, stepDays);
    localDue = `${date}${anchor.localDue.slice(10)}`;
    dueAt = scheduledLocalWallClockToInstant(localDue, anchor.timeZone);
  }
  return { dueAt, localDue };
}

/** Creation remains strict even though advancement has a defined daylight-saving policy. */
export function firstClockOccurrence(
  clock: string,
  weekday: number | null,
  now: Date,
  zone: string
) {
  let date = localDayKey(now, zone);
  if (weekday !== null) {
    const todayWeekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    date = addLocalDays(date, (weekday - todayWeekday + 7) % 7);
  }
  let localDue = `${date}T${clock}`;
  // Compare the local clock before resolving, so yesterday's ambiguous hour cannot block tomorrow.
  const localNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23"
  })
    .format(now)
    .replace(" ", "T");
  if (localDue <= localNow) {
    date = addLocalDays(date, weekday === null ? 1 : 7);
    localDue = `${date}T${clock}`;
  }
  return { dueAt: strictLocalWallClockToInstant(localDue, zone), localDue };
}

export function reminderRepeatDescription(
  repeat: ReminderRepeat,
  localDue: string | null,
  zone: string | null,
  clockFormat: LocaleDateFormat = "24"
) {
  if (repeat.kind === "interval") {
    const unit =
      repeat.seconds % 3600 === 0 ? "hour" : repeat.seconds % 60 === 0 ? "minute" : "second";
    const count = repeat.seconds / (unit === "hour" ? 3600 : unit === "minute" ? 60 : 1);
    return `Every ${count} ${unit}${count === 1 ? "" : "s"}`;
  }
  const weekday =
    repeat.kind === "weekly" && localDue
      ? new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
          new Date(`${localDue.slice(0, 10)}T12:00:00Z`)
        )
      : "day";
  const [hour, minute] = localDue!.slice(11).split(":").map(Number);
  return `Every ${weekday} at ${formatClock({ hour: hour!, minute: minute! }, clockFormat)} (${zone})`;
}
