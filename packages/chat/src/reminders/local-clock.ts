// #3150: resolves a recognised clock-time reminder to exact instants in the owner's time zone.
// Daylight saving is never guessed. A time the clocks skip, or show twice, is refused.

import {
  StrictLocalWallClockError,
  addLocalDays,
  localDayKey,
  strictLocalWallClockToInstant
} from "@moss/module-sdk";

import type { LocalClockSpec, LocalClockTime } from "./clock-recognizer.js";

/** A deadline further than this after the reminder time is almost always a mistake. */
const REMINDER_DEADLINE_MAX_AFTER_MS = 12 * 3600 * 1000;

export interface ResolvedLocalClock {
  readonly kind: "resolved";
  readonly dueAt: Date;

  /** The wall clock the owner asked for, `YYYY-MM-DDTHH:mm`, in `timeZone`. */
  readonly localDue: string;
  readonly deadlineAt: Date | null;
  readonly localDeadline: string | null;
  readonly timeZone: string;
}

export type LocalClockRefusal =
  | { readonly kind: "refused"; readonly reason: "time_passed"; readonly time: LocalClockTime }
  | {
      readonly kind: "refused";
      readonly reason: "dst_gap" | "dst_fold";
      readonly localDate: string;
      readonly time: LocalClockTime;
    }
  | { readonly kind: "refused"; readonly reason: "deadline_too_far" };

export function resolveLocalClock(
  spec: LocalClockSpec,
  now: Date,
  timeZone: string
): ResolvedLocalClock | LocalClockRefusal {
  const today = localDayKey(now, timeZone);
  const nowLocal = localWallClock(now, timeZone);
  const hhmm = clockKey(spec.time);

  let dueDate = spec.day === "tomorrow" ? addLocalDays(today, 1) : today;
  if (`${dueDate}T${hhmm}` <= nowLocal) {
    if (spec.day !== null) return { kind: "refused", reason: "time_passed", time: spec.time };
    dueDate = addLocalDays(today, 1);
  }

  const due = toInstant(dueDate, spec.time, timeZone);
  if (due.kind === "refused") return due;
  if (spec.deadline === null) {
    return {
      kind: "resolved",
      dueAt: due.instant,
      localDue: due.local,
      deadlineAt: null,
      localDeadline: null,
      timeZone
    };
  }

  // The deadline is the next time its clock time comes round after the reminder time.
  const sameDay = `${dueDate}T${clockKey(spec.deadline)}`;
  const deadlineDate = sameDay > due.local ? dueDate : addLocalDays(dueDate, 1);
  const deadline = toInstant(deadlineDate, spec.deadline, timeZone);
  if (deadline.kind === "refused") return deadline;
  if (deadline.instant.getTime() - due.instant.getTime() > REMINDER_DEADLINE_MAX_AFTER_MS) {
    return { kind: "refused", reason: "deadline_too_far" };
  }
  return {
    kind: "resolved",
    dueAt: due.instant,
    localDue: due.local,
    deadlineAt: deadline.instant,
    localDeadline: deadline.local,
    timeZone
  };
}

function toInstant(
  localDate: string,
  time: LocalClockTime,
  timeZone: string
):
  | { readonly kind: "instant"; readonly instant: Date; readonly local: string }
  | LocalClockRefusal {
  const local = `${localDate}T${clockKey(time)}`;
  try {
    return { kind: "instant", instant: strictLocalWallClockToInstant(local, timeZone), local };
  } catch (error) {
    if (error instanceof StrictLocalWallClockError) {
      if (error.reason === "dst-gap") {
        return { kind: "refused", reason: "dst_gap", localDate, time };
      }
      if (error.reason === "dst-fold") {
        return { kind: "refused", reason: "dst_fold", localDate, time };
      }
    }
    throw error;
  }
}

function clockKey(time: LocalClockTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** The wall clock `instant` shows in `timeZone`, as `YYYY-MM-DDTHH:mm`. */
export function localWallClock(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${localDayKey(instant, timeZone)}T${value("hour")}:${value("minute")}`;
}
