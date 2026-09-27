import type { LocaleSettingsDto } from "@moss/shared";

import { ampm, timeLabel } from "./today-labels.js";
import type { DayItem } from "./day-plan-view-model.js";

/** A gap this long or shorter reads as "a break"; anything longer reads as "open time".
    Matches the mockup: a 15-minute gap is a break, a 60-minute gap is open time. */
export const SCHEDULE_BREAK_MAX_MINUTES = 30;

/** Gaps shorter than this are rounding noise, not a real gap, and produce no row. */
export const SCHEDULE_GAP_MIN_MINUTES = 1;

const BREAK_LABEL = "A break before the next block";
const OPEN_LABEL = "Open time";

export type ScheduleGapKind = "break" | "open";

export interface ScheduleGapRow {
  readonly key: string;
  readonly kind: ScheduleGapKind;
  readonly afterItemKey: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly label: string;
}

export interface ScheduleClosingLine {
  readonly key: string;
  readonly afterItemKey: string;
  readonly text: string;
}

export interface ScheduleGaps {
  readonly rows: readonly ScheduleGapRow[];
  readonly closing: ScheduleClosingLine | null;
}

interface TimedItem {
  readonly key: string;
  readonly startMs: number;
  /** null means this item's end is unknown - it acts as a barrier in the gap chain. */
  readonly endMs: number | null;
}

function resolveEnd(item: DayItem): number | null {
  if (item.startsAt === null) return null;
  if (item.endsAt !== null) return Date.parse(item.endsAt);
  if (item.durationMinutes !== null && item.durationMinutes > 0) {
    return Date.parse(item.startsAt) + item.durationMinutes * 60000;
  }
  return null;
}

function compactTime(iso: string, locale: LocaleSettingsDto): string {
  return `${timeLabel(iso, locale)}${ampm(iso, locale)}`;
}

/** Derives gap/break rows and the closing line from every item with a real start, tracking the
    furthest occupied end seen so far rather than just the previous neighbor - a long event that
    contains shorter ones must not read as a break between the short ones. An item with a start
    but no computable end (no endsAt and no positive durationMinutes) acts as a barrier: nothing
    is ever bridged across it, and the closing line only reports a time once the furthest occupied
    end is known again from a later item that does have a computable end. */
export function buildScheduleGaps(
  items: readonly DayItem[],
  locale: LocaleSettingsDto
): ScheduleGaps {
  const timed: TimedItem[] = [];
  for (const item of items) {
    if (item.startsAt === null) continue;
    timed.push({ key: item.key, startMs: Date.parse(item.startsAt), endMs: resolveEnd(item) });
  }
  timed.sort((a, b) => a.startMs - b.startMs);

  const rows: ScheduleGapRow[] = [];
  // occupiedUntil/occupiedUntilKey is null both before the first known end is seen and
  // whenever a barrier item (unknown end) was last processed - both cases mean "we cannot
  // vouch for anything before the next known-end item", so no gap is emitted for that span.
  let occupiedUntil: number | null = null;
  let occupiedUntilKey: string | null = null;

  for (const current of timed) {
    if (occupiedUntil !== null && occupiedUntilKey !== null) {
      const gapMinutes = (current.startMs - occupiedUntil) / 60000;
      if (gapMinutes >= SCHEDULE_GAP_MIN_MINUTES) {
        const kind: ScheduleGapKind = gapMinutes <= SCHEDULE_BREAK_MAX_MINUTES ? "break" : "open";
        rows.push({
          key: `gap:${occupiedUntilKey}`,
          kind,
          afterItemKey: occupiedUntilKey,
          startsAt: new Date(occupiedUntil).toISOString(),
          endsAt: new Date(current.startMs).toISOString(),
          label: kind === "break" ? BREAK_LABEL : OPEN_LABEL
        });
      }
    }

    if (current.endMs === null) {
      // Unknown end: never bridge across it, and stop vouching for time until a later
      // item with a known end resets the baseline.
      occupiedUntil = null;
      occupiedUntilKey = null;
      continue;
    }

    if (occupiedUntil === null || current.endMs > occupiedUntil) {
      occupiedUntil = current.endMs;
      occupiedUntilKey = current.key;
    }
  }

  const closing: ScheduleClosingLine | null =
    occupiedUntil === null || occupiedUntilKey === null
      ? null
      : {
          key: `closing:${occupiedUntilKey}`,
          afterItemKey: occupiedUntilKey,
          text: `The evening is open. No more commitments after ${compactTime(new Date(occupiedUntil).toISOString(), locale)}.`
        };

  return { rows, closing };
}
