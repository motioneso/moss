import { assertDataContextDb, type CalendarEvent, type DataContextDb } from "@moss/db";

import { CalendarRepository } from "./repository.js";
import { serializeCalendarEvent } from "./serialize.js";

/**
 * The calendar block Moss created that is on right now. Public read for other parts of Moss (the
 * Trail Marker focus judgment); it returns only what a caller needs and nothing about attendees,
 * locations or notes.
 */
export interface CurrentMossBlock {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

// The value the Google sync writes into event metadata for a cancelled event.
const CANCELLED_STATUS = "cancelled";

function millis(value: Date | string): number {
  return new Date(value).getTime();
}

/**
 * Pure choice among events already loaded: a Moss-created, timed, not-cancelled event covering
 * `now`. A start exactly at `now` counts; an end exactly at `now` does not. When blocks overlap,
 * the one ending first wins and ties break by id, so the answer never flips between calls.
 */
export function pickCurrentMossBlock(
  events: readonly CalendarEvent[],
  now: Date
): CurrentMossBlock | null {
  const nowMs = now.getTime();
  const candidates = events
    .filter((event) => {
      const dto = serializeCalendarEvent(event);
      if (!dto.isMossBlock || dto.allDay || dto.status === CANCELLED_STATUS) return false;
      return millis(event.starts_at) <= nowMs && millis(event.ends_at) > nowMs;
    })
    .sort((a, b) => {
      const byEnd = millis(a.ends_at) - millis(b.ends_at);
      if (byEnd !== 0) return byEnd;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const first = candidates[0];
  if (!first) return null;
  return {
    id: first.id,
    title: first.title,
    startsAt: new Date(first.starts_at),
    endsAt: new Date(first.ends_at)
  };
}

/**
 * Reads the caller's own events through the scoped connection. The calendar's row policy also lets
 * through events other people shared with the caller, and someone else's focus block is never the
 * caller's goal, so the read also keeps only rows the actor owns.
 */
export async function getCurrentMossBlock(
  scopedDb: DataContextDb,
  now: Date
): Promise<CurrentMossBlock | null> {
  assertDataContextDb(scopedDb);
  const events = await new CalendarRepository().listVisible(scopedDb, {
    endsAfter: now,
    ownedByActor: true,
    // The repository compares starts with "<", so one millisecond past `now` includes an event
    // that starts exactly at `now`.
    startsBefore: new Date(now.getTime() + 1)
  });
  return pickCurrentMossBlock(events, now);
}
