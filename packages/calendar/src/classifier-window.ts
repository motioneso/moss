import { DEFAULT_TIMEZONE, localDayBounds } from "./focus-time.js";

/**
 * Classifier support for `calendar.listVisibleEvents` (plan section 2.3, issue #2883).
 *
 * The classifier may only pick a named window; the concrete instants are derived here in code from
 * the actor's timezone, so a model never supplies or sees an ISO instant. The reply is one
 * code-written sentence: the template checker cannot address an array element, so the handler builds
 * `summary` from the validated result instead.
 */

export const CALENDAR_CLASSIFIER_WINDOWS = ["today", "tomorrow"] as const;
export type CalendarClassifierWindow = (typeof CALENDAR_CLASSIFIER_WINDOWS)[number];

/** Most event titles named in a reply; the rest are counted only. */
const MAX_PREVIEW_TITLES = 3;
/** Longest event title echoed into the reply before it is cut. */
const MAX_TITLE_CHARS = 80;

export function isCalendarClassifierWindow(value: unknown): value is CalendarClassifierWindow {
  return value === "today" || value === "tomorrow";
}

export interface ClassifierWindowRange {
  readonly startsAfter: Date;
  readonly startsBefore: Date;
  readonly label: "today" | "tomorrow";
}

/** The `[start, end)` instants of a named local civil day, resolved in `timeZone`. */
export function classifierWindowRange(
  window: CalendarClassifierWindow,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE
): ClassifierWindowRange {
  const today = localDayBounds(now, timeZone);
  if (window === "today") {
    return { startsAfter: today.start, startsBefore: today.end, label: "today" };
  }
  const tomorrow = localDayBounds(today.end, timeZone);
  return { startsAfter: tomorrow.start, startsBefore: tomorrow.end, label: "tomorrow" };
}

function boundedTitles(events: readonly { readonly title: string }[]): string[] {
  const titles: string[] = [];
  for (const event of events) {
    if (titles.length === MAX_PREVIEW_TITLES) break;
    const title = typeof event.title === "string" ? event.title.trim() : "";
    if (title === "") continue;
    titles.push(
      title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 3)}...` : title
    );
  }
  return titles;
}

export interface CalendarSummaryOptions {
  readonly label: string;
  /** True when any account used cached data or could not be read at all. */
  readonly degraded: boolean;
  /** True when the source cut the list short. */
  readonly truncated: boolean;
}

/**
 * One code-written sentence about a day's events. Returns `null` when the result is not a complete,
 * live picture — the source cut the list short, or any account used cached data or could not be read
 * — so the classifier gate declines and the message goes to the main model. A partial list is never
 * stated as a full answer, not even with a caveat.
 */
export function summarizeCalendarEvents(
  events: readonly { readonly title: string }[],
  options: CalendarSummaryOptions
): string | null {
  if (options.truncated || options.degraded) return null;

  const count = events.length;
  const head =
    count === 0
      ? `No events ${options.label}.`
      : count === 1
        ? `1 event ${options.label}.`
        : `${count} events ${options.label}.`;

  const titles = boundedTitles(events);
  const preview = titles.length > 0 ? ` Next: ${titles.join("; ")}.` : "";
  return `${head}${preview}`;
}
