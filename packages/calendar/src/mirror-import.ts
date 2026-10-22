import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { isValidTimeZone, localDayRange } from "@moss/module-sdk";

import { CalendarRepository } from "./repository.js";

export const OUTLOOK_CALENDAR_MIRROR = "outlook-browser-calendar";

export interface CalendarMirrorObservation {
  readonly occurrenceKey: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly timeZone: string;
}

export interface CalendarMirrorBatch {
  readonly calendarKey: string;
  readonly timeZone: string;
  readonly observedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly events: readonly CalendarMirrorObservation[];
}

export function calendarMirrorExternalId(calendarKey: string, occurrenceKey: string): string {
  // JSON tuple identity: no title/time hash and no ambiguous concatenation.
  return JSON.stringify([calendarKey, occurrenceKey]);
}

export function validateCalendarMirrorBatch(batch: CalendarMirrorBatch): void {
  const instant = (s: string) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && instant(`${s}T00:00:00.000Z`);
  if (
    !batch.calendarKey ||
    batch.calendarKey.length > 200 ||
    !isValidTimeZone(batch.timeZone) ||
    !instant(batch.observedAt) ||
    !day(batch.windowStart) ||
    !day(batch.windowEnd) ||
    batch.windowEnd <= batch.windowStart ||
    Date.parse(batch.windowEnd) - Date.parse(batch.windowStart) > 33 * 86400000 ||
    batch.events.length > 1000
  )
    throw new Error("Invalid calendar mirror batch");
  const seen = new Set<string>();
  const start = localDayRange(batch.windowStart, batch.timeZone).start.toISOString();
  const end = localDayRange(batch.windowEnd, batch.timeZone).start.toISOString();
  for (const event of batch.events) {
    if (
      !event.occurrenceKey ||
      event.occurrenceKey.length > 512 ||
      seen.has(event.occurrenceKey) ||
      !event.title.trim() ||
      event.title.length > 1000 ||
      event.timeZone !== batch.timeZone ||
      !instant(event.startsAt) ||
      !instant(event.endsAt) ||
      typeof event.allDay !== "boolean" ||
      event.endsAt <= event.startsAt ||
      (event.allDay
        ? event.endsAt.slice(0, 10) <= batch.windowStart ||
          event.startsAt.slice(0, 10) >= batch.windowEnd
        : event.endsAt <= start || event.startsAt >= end) ||
      (event.allDay &&
        (!event.startsAt.endsWith("T00:00:00.000Z") || !event.endsAt.endsWith("T00:00:00.000Z")))
    ) {
      throw new Error("Invalid calendar mirror event");
    }
    seen.add(event.occurrenceKey);
  }
}

/** Public calendar import boundary. The caller must enter its normal owner DataContext. */
export async function importCalendarMirror(
  scopedDb: DataContextDb,
  connectorAccountId: string,
  batch: CalendarMirrorBatch,
  repository = new CalendarRepository()
): Promise<{ upserted: number; unconfirmed: number }> {
  assertDataContextDb(scopedDb);
  // Validate the entire batch before the first write, including partial observations.
  validateCalendarMirrorBatch(batch);
  const range = JSON.stringify([
    batch.calendarKey,
    batch.timeZone,
    batch.windowStart,
    batch.windowEnd
  ]);
  const observed = new Set<string>();
  let upserted = 0;
  for (const event of batch.events) {
    const externalId = calendarMirrorExternalId(batch.calendarKey, event.occurrenceKey);
    observed.add(externalId);
    const prior = await repository.getByExternalId(scopedDb, { connectorAccountId, externalId });
    const priorTimes = [
      prior?.external_metadata?.observedAt,
      prior?.external_metadata?.mirrorMissingObservedAt
    ].filter((v): v is string => typeof v === "string");
    const priorTime = priorTimes.sort().at(-1);
    if (typeof priorTime === "string" && priorTime >= batch.observedAt) continue;
    await repository.upsertCachedEvent(scopedDb, {
      connectorAccountId,
      externalId,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      externalMetadata: {
        source: OUTLOOK_CALENDAR_MIRROR,
        readOnly: true,
        allDay: event.allDay,
        sourceTimeZone: event.timeZone,
        observedAt: batch.observedAt,
        mirrorMissingCount: 0,
        mirrorMissingRange: null,
        mirrorMissingObservedAt: null,
        mirrorUnconfirmed: false,
        mirrorState: batch.complete ? "current" : "partial"
      }
    });
    upserted++;
  }
  let unconfirmed = 0;
  // A partial view can update observations, but cannot turn absence into any conclusion.
  if (batch.complete) {
    const prior = await repository.listMirrorWindow(
      scopedDb,
      connectorAccountId,
      batch.windowStart,
      batch.windowEnd,
      batch.timeZone
    );
    for (const row of prior) {
      if (observed.has(row.external_id)) continue;
      const md = row.external_metadata;
      if (typeof md.observedAt === "string" && md.observedAt >= batch.observedAt) continue;
      if (
        typeof md.mirrorMissingObservedAt === "string" &&
        md.mirrorMissingObservedAt >= batch.observedAt
      )
        continue;
      if (!row.external_id.startsWith(JSON.stringify([batch.calendarKey]).slice(0, -1) + ","))
        continue;
      const misses =
        md.mirrorMissingRange === range && typeof md.mirrorMissingCount === "number"
          ? md.mirrorMissingCount + 1
          : 1;
      const missing = Math.min(2, misses);
      const uncertain = md.mirrorUnconfirmed === true || missing === 2;
      if (uncertain) unconfirmed++;
      await repository.updateMirrorMetadata(scopedDb, connectorAccountId, row.id, {
        mirrorMissingRange: range,
        mirrorMissingObservedAt: batch.observedAt,
        mirrorMissingCount: missing,
        mirrorUnconfirmed: uncertain
      });
    }
  }
  return { upserted, unconfirmed };
}
