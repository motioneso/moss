import {
  localDay,
  type CalendarEventDto,
  type LocaleSettingsDto,
  type TaskDto
} from "@moss/shared";

import { formatTime } from "../locale/locale-format";
import { isAtRisk, isDoFirst } from "../tasks/focus";

/**
 * Empty-state "seed" prompts for the chat drawer. These must be *honest*: a seed
 * may only reference something that actually exists. We never hardcode a concrete
 * detail (e.g. "Move my 3:30") unless the underlying data is present — otherwise we
 * fall back to data-independent generics that are always answerable.
 *
 * Derived client-side from the already-cached tasks + calendar queries; no extra
 * round-trip. (LLM-generated suggestions are a possible later enhancement — see #218.)
 */
export function buildChatSeeds(
  tasks: readonly TaskDto[],
  events: readonly CalendarEventDto[],
  locale: LocaleSettingsDto
): string[] {
  const open = tasks.filter((t) => t.parentTaskId === null && t.status === "todo");
  const hasPriorities = open.some(isDoFirst);
  const hasAtRisk = open.some((t) => isAtRisk(t, locale.timezone));
  const nextEvent = nextUpcomingToday(events, locale.timezone);

  const seeds: string[] = [];

  // Data-specific (gated on a real upcoming event): names a concrete time, so it
  // only appears when that time genuinely exists on the calendar.
  if (nextEvent) {
    seeds.push(`Move my ${eventTime(nextEvent, locale)} to tomorrow`);
  }

  // Safe generics — always answerable regardless of data.
  if (hasPriorities) {
    seeds.push("What should I focus on today?");
  }
  if (hasAtRisk) {
    seeds.push("What's slipping that I should deal with?");
  }
  seeds.push("What did I tell you I wanted to do this week?");

  // Guarantee at least two starters even on an empty account.
  if (seeds.length < 2) {
    seeds.push("What should I focus on today?");
  }

  return dedupe(seeds).slice(0, 3);
}

function nextUpcomingToday(
  events: readonly CalendarEventDto[],
  timeZone?: string
): CalendarEventDto | null {
  const now = Date.now();
  const upcoming = events
    .filter((e) => isToday(e.startsAt, timeZone) && new Date(e.startsAt).getTime() >= now)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  return upcoming[0] ?? null;
}

/** Whether an instant lands on the user's local "today" (#579), not the ambient zone. */
function isToday(iso: string, timeZone?: string): boolean {
  return localDay(iso, timeZone) === localDay(new Date(), timeZone);
}

/** Casual clock label in the person's zone and region: "3:30pm"/"9am" for 12-hour, "15:30" for
    24-hour (#579, #3393). */
function eventTime(event: CalendarEventDto, locale: LocaleSettingsDto): string {
  if (locale.dateFormat === "24") return formatTime(event.startsAt, locale);
  return formatTime(event.startsAt, locale, { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s+/g, "")
    .replace(":00", "")
    .toLowerCase();
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
