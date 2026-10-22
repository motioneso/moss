import type { DataContextDb } from "@moss/db";
import { isValidTimeZone, localDayRange } from "@moss/module-sdk";
import { CalendarRepository } from "./repository.js";
import { OUTLOOK_CALENDAR_MIRROR } from "./mirror-import.js";

/** Cached and unconfirmed Outlook commitments remain busy until verified in the source. */
export async function calendarMirrorBusy(
  db: DataContextDb,
  start: Date,
  end: Date,
  repository = new CalendarRepository()
): Promise<{ start: string; end: string }[]> {
  const rows = await repository.listVisible(db, {
    ownedByActor: true,
    endsAfter: new Date(start.getTime() - 86400000),
    startsBefore: new Date(end.getTime() + 86400000)
  });
  return rows
    .filter((row) => row.external_metadata.source === OUTLOOK_CALENDAR_MIRROR)
    .map((row) => {
      const md = row.external_metadata;
      let a = new Date(row.starts_at);
      let b = new Date(row.ends_at);
      if (md.allDay === true) {
        if (typeof md.sourceTimeZone !== "string" || !isValidTimeZone(md.sourceTimeZone))
          throw new Error("Outlook calendar timezone needs verification");
        a = localDayRange(a.toISOString().slice(0, 10), md.sourceTimeZone).start;
        b = localDayRange(b.toISOString().slice(0, 10), md.sourceTimeZone).start;
      }
      return { start: a.toISOString(), end: b.toISOString() };
    })
    .filter((interval) => interval.start < end.toISOString() && interval.end > start.toISOString());
}
