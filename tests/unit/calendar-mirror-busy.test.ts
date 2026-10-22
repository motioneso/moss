import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type CalendarEvent, type DataContextDb } from "@moss/db";
import { CalendarRepository } from "../../packages/calendar/src/repository.js";
import { calendarMirrorBusy } from "../../packages/calendar/src/mirror-busy.js";

const db = { [dataContextBrand]: true, db: {} } as unknown as DataContextDb;
const start = new Date("2026-11-01T06:30:00Z");
const end = new Date("2026-11-02T09:00:00Z");
function harness(metadata: Record<string, unknown>) {
  const repository = new CalendarRepository();
  const list = vi.spyOn(repository, "listVisible").mockResolvedValue([
    {
      id: "invented-row",
      owner_user_id: "owner",
      connector_account_id: "account",
      external_id: "invented",
      title: "Invented",
      location: null,
      summary: null,
      body_excerpt: null,
      created_at: start,
      updated_at: start,
      starts_at: new Date("2026-11-01T00:00:00Z"),
      ends_at: new Date("2026-11-02T00:00:00Z"),
      external_metadata: { source: "outlook-browser-calendar", ...metadata }
    } satisfies CalendarEvent
  ]);
  return { repository, list };
}
describe("cached Outlook busy times", () => {
  it("keeps unconfirmed all-day commitments busy across the source-zone DST boundary", async () => {
    const { repository, list } = harness({
      allDay: true,
      sourceTimeZone: "America/Los_Angeles",
      mirrorUnconfirmed: true,
      mirrorState: "partial"
    });
    expect(await calendarMirrorBusy(db, start, end, repository)).toEqual([
      { start: "2026-11-01T07:00:00.000Z", end: "2026-11-02T08:00:00.000Z" }
    ]);
    expect(list).toHaveBeenCalledWith(db, expect.objectContaining({ ownedByActor: true }));
  });
  it("refuses an unverified all-day timezone instead of advertising free time", async () => {
    const { repository } = harness({ allDay: true });
    await expect(calendarMirrorBusy(db, start, end, repository)).rejects.toThrow("timezone");
  });
  it("does not duplicate Google busy intervals", async () => {
    const { repository } = harness({ source: "google" });
    expect(await calendarMirrorBusy(db, start, end, repository)).toEqual([]);
  });
});
