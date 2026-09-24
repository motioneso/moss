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

/** Morning schedule dateline: "Wednesday, September 9". */
export function shortDatelineLabel(now: Date, locale: LocaleSettingsDto): string {
  return formatDate(now.toISOString(), locale, { weekday: "long", month: "long", day: "numeric" });
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

/** Report shell (V5): the briefing tab and the phone schedule disclosure. */
export const BRIEFING_TAB_LABEL = "The briefing";
export const SCHEDULE_TOGGLE_LABEL = "Today's schedule";

/** Bulk acceptance (T19): one activation for every eligible proposed addition. */
export const ACCEPT_ALL_LABEL = "Accept all time blocks";
/** Proposed Read footer (P5): the review hand-off reads as a link ahead of
    the primary action, named for what it opens rather than the generic
    "Review task blocks" the automatic Read keeps. */
export const REVIEW_PROPOSED_BLOCKS_LABEL = "Review proposed blocks";
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

/** Evening planning surface (T20). */
export const PLAN_TOMORROW_LABEL = "Plan tomorrow";
export const SAVE_TOMORROW_LABEL = "Save tomorrow's plan";
export const EVENING_REVIEW_NOT_READY = "Your evening review is not ready yet";
export const NO_ROOM_FOUND = "No room found";

/** Evening step frame (V7): the strip label, the four step names in order,
    the reflect question, the rail heading and the speaker note. */
export const EVENING_PLAN_STEPS_LABEL = "Plan steps";
export const EVENING_STEP_NAMES = [
  "Reflect",
  "Open commitments",
  "Shape tomorrow",
  "Review"
] as const;
export const EVENING_REFLECT_QUESTION =
  "What should I understand about today before we plan tomorrow?";
export const EVENING_RAIL_HEADING = "Tomorrow, taking shape.";
export const EVENING_SPEAKER_NAME = "Moss";
export const EVENING_SPEAKER_NOTE = "Looking back with you";

/** Evening steps 2 to 4 (V8): speaker notes, large messages and review groups. */
export const EVENING_COMMIT_NOTE = "Only the loose ends that matter";
export const EVENING_COMMIT_MESSAGE = "Give this a place, or leave it open.";
export const EVENING_SHAPE_NOTE = "A realistic starting point";
export const EVENING_SHAPE_MESSAGE = "How much room do you want tomorrow?";
export const EVENING_REVIEW_NOTE = "Here is what will change";
export const EVENING_REVIEW_MESSAGE = "A plan you can leave with.";
export const EVENING_REVIEW_CHANGES_HEADING = "Changes";
export const EVENING_REVIEW_KEEP_HEADING = "Keep as they are";
export const EVENING_REVIEW_NO_CHANGE_HEADING = "No change";
export const EVENING_REVIEW_NO_CHANGES = "Nothing changes tomorrow.";

/** Unsaved review deltas beside the saved schedule's own words (T18). */
export const REVIEW_TRANSIENT_LABELS = {
  toSchedule: "To schedule",
  timeChange: "Time change to save",
  willRemove: "Will be removed"
} as const;

/** Section index and hero utility row labels. */
export const BRIEFING_NOT_READY_LABEL = "Briefing not ready yet";
export const TODAY_SECTION_INDEX_LABEL = "In this briefing";
export const TODAY_SECTION_LINKS = [
  { href: "#start-here", label: "Your day & preparation" },
  { href: "#needs-you", label: "Quick actions" },
  { href: "#news", label: "News" },
  { href: "#sports", label: "Sports" }
] as const;

/** Morning hero copy shared by the day-mode kicker and reader links. */
export const MORNING_BRIEFING_TITLE = "Morning briefing";
export const MORNING_READ_FULL_LABEL = "Read the full morning briefing";
export function morningHeroKicker(firstName: string | null): string {
  const name = (firstName ?? "").trim();
  return name
    ? `${greeting()}, ${name} / ${MORNING_BRIEFING_TITLE}`
    : `${greeting()} / ${MORNING_BRIEFING_TITLE}`;
}

/** Evening step 1 reflection choices and note composer (VP-REFLECTION-R1). */
export const EVENING_REFLECT_CHOICE_CAPTURES_TITLE = "That captures it";
export const EVENING_REFLECT_CHOICE_CAPTURES_HINT = "I'm ready to look ahead.";
export const EVENING_REFLECT_CHOICE_UNSENT_TITLE = "The follow-up isn't sent";
export const EVENING_REFLECT_CHOICE_UNSENT_HINT = "I still need to send the message.";
export const EVENING_REFLECT_CHOICE_TOOK_MORE_TITLE = "It took more out of me than expected";
export const EVENING_REFLECT_CHOICE_TOOK_MORE_HINT = "Make some room in tomorrow's plan.";

export const EVENING_REFLECT_CHOICES = [
  {
    id: "captures",
    title: EVENING_REFLECT_CHOICE_CAPTURES_TITLE,
    hint: EVENING_REFLECT_CHOICE_CAPTURES_HINT
  },
  {
    id: "unsent",
    title: EVENING_REFLECT_CHOICE_UNSENT_TITLE,
    hint: EVENING_REFLECT_CHOICE_UNSENT_HINT
  },
  {
    id: "took-more",
    title: EVENING_REFLECT_CHOICE_TOOK_MORE_TITLE,
    hint: EVENING_REFLECT_CHOICE_TOOK_MORE_HINT
  }
] as const;

export const EVENING_REFLECT_NOTE_LABEL = "Or tell Moss in your own words";
export const EVENING_REFLECT_NOTE_PLACEHOLDER =
  "A correction, a constraint, or something to remember…";
export const EVENING_REFLECT_ADD_NOTE_LABEL = "Add note";

/** Evening hero, recap and open-loops copy (VP-EVENING-SUMMARY-R1). The hero
    kicker names the signed-in user's first name; without one it stands alone. */
export const EVENING_KICKER = "Good evening";
export const EVENING_BRIEFING_TITLE = "Evening briefing";
export function eveningHeroKicker(firstName: string | null): string {
  const name = (firstName ?? "").trim();
  return name
    ? `${EVENING_KICKER}, ${name} / ${EVENING_BRIEFING_TITLE}`
    : `${EVENING_KICKER} / ${EVENING_BRIEFING_TITLE}`;
}
export const EVENING_SECTION_DAY_LABEL = "Your day & tomorrow";
export const EVENING_READ_FULL_LABEL = "Read the full evening briefing";
export const EVENING_SOURCES_LABEL = "What informed this?";
export const MORNING_SOURCES_LABEL = EVENING_SOURCES_LABEL;
export const EVENING_RECAP_KICKER = "01";
export const EVENING_RECAP_HEADING = "What happened today";
export const EVENING_OPEN_LOOPS_KICKER = "02";
export const EVENING_OPEN_LOOPS_HEADING = "Close the open loops";
export const EVENING_OPEN_LOOPS_EMPTY = "Nothing urgent is carrying forward.";

/** Morning reader Review rows (VP-AUTOMATIC-REVIEW-R1). */
export const REVIEW_KEEP_ON_CALENDAR_LABEL = "Keep on calendar";
export const REVIEW_WHAT_WILL_CHANGE_HEADING = "What will change";
export const REVIEW_NO_CHANGES_SELECTED = "No changes selected.";

/** Morning reader Review screen (VP-SCREEN-REVIEW-R1). */
export const REVIEW_TITLE = "Your day, prepared.";
export const REVIEW_WITHOUT_TIME_BLOCK_HEADING = "Without a time block";
