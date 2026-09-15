import {
  localDay,
  type CalendarEventDto,
  type LocaleSettingsDto,
  type TaskDto
} from "@moss/shared";

import { formatDate, formatTime } from "../locale/locale-format";
import type { TodayMode } from "./evening-mode";

/** Pure label/headline helpers for the Today masthead and brief lists — no React. */

const NUM_WORDS = [
  "ZERO",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "SEVEN",
  "EIGHT",
  "NINE",
  "TEN",
  "ELEVEN",
  "TWELVE"
] as const;

function numWord(n: number): string {
  return NUM_WORDS[n] ?? String(n);
}

export function buildHeadline(
  mode: TodayMode,
  needsYou: number,
  eventsLeft: number,
  done: number
): { readonly top: string; readonly accent: string } {
  if (mode === "evening") {
    if (done > 0) return { top: numWord(done), accent: done === 1 ? "THING DONE" : "THINGS DONE" };
    return { top: "THE DAY,", accent: "REVIEWED" };
  }
  if (needsYou > 0)
    return { top: numWord(needsYou), accent: needsYou === 1 ? "NEEDS YOU" : "NEED YOU" };
  if (eventsLeft > 0) return { top: numWord(eventsLeft), accent: "ON THE BOOKS" };
  return { top: "ALL CLEAR", accent: "TODAY" };
}

export function datelineLabel(now: Date, locale: LocaleSettingsDto): string {
  const iso = now.toISOString();
  const weekday = formatDate(iso, locale, { weekday: "long" });
  const date = formatDate(iso, locale, { day: "2-digit", month: "long", year: "numeric" });
  // Edition number = day of the year in the user's timezone, newspaper-masthead style.
  const key = localDay(now, locale.timezone);
  const edition =
    Math.floor(
      (Date.parse(`${key}T00:00:00Z`) - Date.parse(`${key.slice(0, 4)}-01-01T00:00:00Z`)) /
        86_400_000
    ) + 1;
  return `${weekday} · ${date} · No.${edition}`;
}

export function countdownLabel(iso: string, now: Date): string {
  const mins = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60_000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function firstName(name: string, email: string): string {
  const source = name.trim() || email.split("@")[0] || "there";
  const base = source.split(/\s+/)[0] ?? source;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Oxford-style list join: "A", "A and B", "A, B, and C". Commas between every clause with a
// single "and" before the last — the old `parts.join(", and ")` double-printed the conjunction
// ("complete, and carrying, and events"); Ben 2026-07-07: drop the first "and".
export function joinClauses(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function buildLede(priorities: number, atRisk: number, events: number): string {
  const parts: string[] = [];
  parts.push(
    priorities > 0
      ? `You have <b>${priorities} ${priorities === 1 ? "priority" : "priorities"}</b> to move today`
      : "Nothing pressing right now"
  );
  if (events > 0) parts.push(`${events} ${events === 1 ? "event" : "events"} on the calendar`);
  if (atRisk > 0)
    parts.push(
      `${atRisk} ${atRisk === 1 ? "thing has" : "things have"} slipped: we can reset without rushing`
    );
  return `${joinClauses(parts)}.`;
}

/** Drift bucket, day-classified in the user's persisted timezone (#579): the due date
    and "today" are compared as `YYYY-MM-DD` keys resolved in `timeZone`, not the ambient
    browser zone, so an evening-UTC due date doesn't read as "overdue" a day early. */
export function driftOf(task: TaskDto, timeZone?: string): "atrisk" | "overdue" | null {
  if (!task.dueAt || task.status === "done") return null;
  const todayK = localDay(new Date(), timeZone);
  const dueK = localDay(task.dueAt, timeZone);
  if (dueK < todayK) return "overdue";
  // Both keys are user-zone `YYYY-MM-DD` → parse as UTC midnight for an exact day delta.
  const driftDays =
    (Date.parse(`${dueK}T00:00:00Z`) - Date.parse(`${todayK}T00:00:00Z`)) / 86_400_000;
  if (driftDays <= 2) return "atrisk";
  return null;
}

export function dueTs(task: TaskDto): number {
  return task.dueAt ? new Date(task.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
}

/** Whether a calendar event starts on the user's local "today" (#579). */
export function isToday(event: CalendarEventDto, timeZone?: string): boolean {
  return localDay(event.startsAt, timeZone) === localDay(new Date(), timeZone);
}

export function byStart(a: CalendarEventDto, b: CalendarEventDto): number {
  return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
}

export function timeLabel(iso: string, locale: LocaleSettingsDto): string {
  return formatTime(iso, locale, { hour: "numeric", minute: "2-digit", hour12: true }).replace(
    /\s?[AP]M$/i,
    ""
  );
}

export function ampm(iso: string, locale: LocaleSettingsDto): string {
  return /pm$/i.test(formatTime(iso, locale, { hour: "numeric", hour12: true })) ? "pm" : "am";
}

export function durationLabel(event: CalendarEventDto): string {
  const mins = Math.round(
    (new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000
  );
  if (mins <= 0) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * #1438 — event cards are plain `<div>`s, so their text is invisible to the page-context
 * capture selector. This composes the one flat string they declare via
 * `data-jarvis-capture-text` (apps/web/src/chat/page-context.ts).
 */
export function eventCaptureText(event: CalendarEventDto, locale: LocaleSettingsDto): string {
  const parts = [
    `${timeLabel(event.startsAt, locale)} ${ampm(event.startsAt, locale)}`,
    event.title
  ];
  if (event.location) parts.push(event.location);
  const duration = durationLabel(event);
  if (duration) parts.push(duration);
  return parts.join(" — ");
}

export function shortDate(iso: string, locale: LocaleSettingsDto): string {
  return formatDate(iso, locale, { month: "short", day: "numeric" });
}

/** Bulk acceptance (T19): one activation for every eligible proposed addition. */
export const ACCEPT_ALL_LABEL = "Accept all time blocks";
export const ACCEPTING_LABEL = "Accepting\u2026";
export const REVIEW_CHANGES_LABEL = "Review changes";
export const ACCEPT_ALL_NEEDS_REVIEW = "These changes need review.";

/** Reader status from the controller: the outcome line plus whether the
    "Review changes" hand-off is offered. Unknown counts as pending. */
export interface AcceptAllStatus {
  readonly line: string;
  readonly needsReview: boolean;
}

export function acceptAllStatus(controller: {
  readonly outcomes: Readonly<Record<string, { outcome: string }>>;
  readonly preview: { readonly conflicts: readonly unknown[] } | null;
  readonly notice: string | null;
}): AcceptAllStatus {
  let applied = 0;
  let failed = 0;
  let pending = 0;
  for (const item of Object.values(controller.outcomes)) {
    if (item.outcome === "applied") applied += 1;
    else if (item.outcome === "failed") failed += 1;
    else pending += 1;
  }
  const skipped = controller.preview?.conflicts.length ?? 0;
  return {
    line: acceptAllOutcomeLine(applied, failed, pending),
    needsReview: failed + pending + skipped > 0 || controller.notice === ACCEPT_ALL_NEEDS_REVIEW
  };
}

/** Reader outcome line from applied/failed/pending counts only; nothing is
    marked applied optimistically, and zero applied reads as nothing added. */
export function acceptAllOutcomeLine(applied: number, failed: number, pending: number): string {
  if (applied === 0) return "Nothing was added";
  let line = `Added ${applied} to the calendar`;
  if (failed > 0) line += `, ${failed} failed`;
  if (pending > 0) line += `, ${pending} pending`;
  return line;
}

/** Unsaved review deltas beside the saved schedule's own words (T18). */
export const REVIEW_TRANSIENT_LABELS = {
  toSchedule: "To schedule",
  timeChange: "Time change to save",
  willRemove: "Will be removed"
} as const;
