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

interface SortedItem {
  readonly key: string;
  readonly startMs: number;
  /** null means this item has no endsAt and no positive durationMinutes. */
  readonly knownEndMs: number | null;
}

function resolveKnownEnd(item: DayItem): number | null {
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

/** An item with no computable end takes the first later start among the other items as its
    end, so it still merges into the running occupied span instead of acting as a barrier. If
    no later start exists, its end stays open (Infinity), which only matters for the closing
    line - a later, earlier-ending item can still merge past it. */
function resolveEndTimes(sorted: readonly SortedItem[]): readonly number[] {
  return sorted.map((item, index) => {
    if (item.knownEndMs !== null) return item.knownEndMs;
    for (let j = index + 1; j < sorted.length; j++) {
      const later = sorted[j]!;
      if (later.startMs > item.startMs) return later.startMs;
    }
    return Infinity;
  });
}

/** Derives gap/break rows and the closing line from every item with a real start, sorted by
    start. `blockEnd` tracks the furthest end seen so far across the whole list, not just the
    previous neighbor, so a long event that contains shorter ones never reads as a break between
    the short ones. Each gap is placed after the item immediately before it in the sorted list,
    even when that item isn't the one that set the current `blockEnd`. */
export function buildScheduleGaps(
  items: readonly DayItem[],
  locale: LocaleSettingsDto
): ScheduleGaps {
  const withStart: SortedItem[] = [];
  for (const item of items) {
    if (item.startsAt === null) continue;
    withStart.push({
      key: item.key,
      startMs: Date.parse(item.startsAt),
      knownEndMs: resolveKnownEnd(item)
    });
  }
  const sorted = [...withStart].sort((a, b) => a.startMs - b.startMs);
  if (sorted.length === 0) {
    return { rows: [], closing: null };
  }

  const endMs = resolveEndTimes(sorted);
  const rows: ScheduleGapRow[] = [];
  let blockEnd = endMs[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const gapMinutes = (current.startMs - blockEnd) / 60000;
    if (gapMinutes >= SCHEDULE_GAP_MIN_MINUTES) {
      const kind: ScheduleGapKind = gapMinutes <= SCHEDULE_BREAK_MAX_MINUTES ? "break" : "open";
      const afterItem = sorted[i - 1]!;
      rows.push({
        key: `gap:${afterItem.key}`,
        kind,
        afterItemKey: afterItem.key,
        startsAt: new Date(blockEnd).toISOString(),
        endsAt: new Date(current.startMs).toISOString(),
        label: kind === "break" ? BREAK_LABEL : OPEN_LABEL
      });
    }
    blockEnd = Math.max(blockEnd, endMs[i]!);
  }

  const lastItem = sorted[sorted.length - 1]!;
  const closing: ScheduleClosingLine | null = Number.isFinite(blockEnd)
    ? {
        key: `closing:${lastItem.key}`,
        afterItemKey: lastItem.key,
        text: `The evening is open. No more commitments after ${compactTime(new Date(blockEnd).toISOString(), locale)}.`
      }
    : null;

  return { rows, closing };
}
