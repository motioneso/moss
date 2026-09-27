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
  readonly endMs: number;
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

/** Derives gap/break rows and the closing line strictly from items that carry both a real start
    and a real, computable end (endsAt, or startsAt + a positive durationMinutes). An item with a
    start but no computable end cannot be bridged from — it is excluded from the gap chain instead
    of being assigned an invented duration. */
export function buildScheduleGaps(
  items: readonly DayItem[],
  locale: LocaleSettingsDto
): ScheduleGaps {
  const timed: TimedItem[] = [];
  for (const item of items) {
    if (item.startsAt === null) continue;
    const endMs = resolveEnd(item);
    if (endMs === null) continue;
    timed.push({ key: item.key, startMs: Date.parse(item.startsAt), endMs });
  }
  timed.sort((a, b) => a.startMs - b.startMs);

  const rows: ScheduleGapRow[] = [];
  for (let i = 0; i < timed.length - 1; i++) {
    const current = timed[i]!;
    const next = timed[i + 1]!;
    const gapMinutes = (next.startMs - current.endMs) / 60000;
    if (gapMinutes < SCHEDULE_GAP_MIN_MINUTES) continue;
    const kind: ScheduleGapKind = gapMinutes <= SCHEDULE_BREAK_MAX_MINUTES ? "break" : "open";
    rows.push({
      key: `gap:${current.key}`,
      kind,
      afterItemKey: current.key,
      startsAt: new Date(current.endMs).toISOString(),
      endsAt: new Date(next.startMs).toISOString(),
      label: kind === "break" ? BREAK_LABEL : OPEN_LABEL
    });
  }

  const last = timed.length > 0 ? timed[timed.length - 1]! : null;
  const closing: ScheduleClosingLine | null =
    last === null
      ? null
      : {
          key: `closing:${last.key}`,
          afterItemKey: last.key,
          text: `The evening is open. No more commitments after ${compactTime(new Date(last.endMs).toISOString(), locale)}.`
        };

  return { rows, closing };
}
