import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type CalendarEvent, type DataContextDb } from "@moss/db";
import {
  calendarMirrorExternalId,
  importCalendarMirror,
  validateCalendarMirrorBatch,
  type CalendarMirrorBatch
} from "../../packages/calendar/src/mirror-import.js";
import { CalendarRepository } from "../../packages/calendar/src/repository.js";

const db = { [dataContextBrand]: true, db: {} } as unknown as DataContextDb;
const firstTime = "2026-10-21T18:00:00.000Z";
const batch = (patch: Partial<CalendarMirrorBatch> = {}): CalendarMirrorBatch => ({
  calendarKey: "primary",
  timeZone: "America/Los_Angeles",
  observedAt: firstTime,
  windowStart: "2026-10-20",
  windowEnd: "2026-11-22",
  complete: true,
  events: [
    {
      occurrenceKey: "one",
      title: "Invented",
      startsAt: "2026-10-22T05:30:00.000Z",
      endsAt: "2026-10-22T06:00:00.000Z",
      allDay: false,
      timeZone: "America/Los_Angeles"
    }
  ],
  ...patch
});
function harness() {
  const rows = new Map<string, CalendarEvent>();
  const repo = new CalendarRepository();
  vi.spyOn(repo, "getByExternalId").mockImplementation(async (_db, input) =>
    rows.get(input.externalId)
  );
  const upsert = vi.spyOn(repo, "upsertCachedEvent").mockImplementation(async (_db, input) => {
    const row: CalendarEvent = {
      id: rows.get(input.externalId)?.id ?? `row-${rows.size}`,
      connector_account_id: input.connectorAccountId,
      owner_user_id: "owner",
      external_id: input.externalId,
      title: input.title,
      starts_at: new Date(input.startsAt),
      ends_at: new Date(input.endsAt),
      external_metadata: input.externalMetadata ?? {},
      location: null,
      summary: null,
      body_excerpt: null,
      created_at: new Date(firstTime),
      updated_at: new Date(firstTime)
    };
    rows.set(input.externalId, row);
    return row;
  });
  const list = vi
    .spyOn(repo, "listMirrorWindow")
    .mockImplementation(async () => [...rows.values()]);
  const update = vi
    .spyOn(repo, "updateMirrorMetadata")
    .mockImplementation(async (_db, _account, id, patch) => {
      const row = [...rows.values()].find((r) => r.id === id)!;
      rows.set(row.external_id, {
        ...row,
        external_metadata: { ...row.external_metadata, ...patch }
      });
    });
  return {
    rows,
    repo,
    upsert,
    list,
    update,
    run: (b: CalendarMirrorBatch) => importCalendarMirror(db, "account", b, repo)
  };
}

describe("calendar mirror import", () => {
  it("updates by source identity, preserves the Moss row, and ignores replayed or older observations", async () => {
    const h = harness();
    await h.run(batch());
    const id = [...h.rows.values()][0]!.id;
    expect(await h.run(batch())).toEqual({ upserted: 0, unconfirmed: 0 });
    const edited = batch({
      observedAt: "2026-10-21T18:05:00.000Z",
      events: batch().events.map((e) => ({
        ...e,
        title: "Edited",
        startsAt: "2026-10-22T05:45:00.000Z"
      }))
    });
    await h.run(edited);
    await h.run(batch());
    expect([...h.rows.values()]).toHaveLength(1);
    expect([...h.rows.values()][0]).toMatchObject({
      id,
      title: "Edited",
      starts_at: new Date("2026-10-22T05:45:00.000Z")
    });
  });

  it("requires two distinct complete observations of the same range, never deleting the event", async () => {
    const h = harness();
    await h.run(batch());
    const missing = batch({ observedAt: "2026-10-21T18:05:00.000Z", events: [] });
    await h.run(missing);
    await h.run(missing);
    expect([...h.rows.values()][0]!.external_metadata).toMatchObject({
      mirrorMissingCount: 1,
      mirrorUnconfirmed: false
    });
    await h.run({ ...missing, observedAt: "2026-10-21T18:10:00.000Z" });
    expect([...h.rows.values()][0]!.external_metadata).toMatchObject({
      mirrorMissingCount: 2,
      mirrorUnconfirmed: true
    });
    expect(h.rows.size).toBe(1);
    await h.run(batch({ observedAt: "2026-10-21T18:15:00.000Z" }));
    expect([...h.rows.values()][0]!.external_metadata).toMatchObject({
      mirrorMissingCount: 0,
      mirrorUnconfirmed: false
    });
  });

  it("does not reconcile absence on partial scans or combine misses across ranges", async () => {
    const h = harness();
    await h.run(batch());
    await h.run(batch({ complete: false, events: [], observedAt: "2026-10-21T18:05:00.000Z" }));
    expect(h.update).not.toHaveBeenCalled();
    await h.run(batch({ events: [], observedAt: "2026-10-21T18:10:00.000Z" }));
    await h.run(
      batch({ windowStart: "2026-10-21", events: [], observedAt: "2026-10-21T18:15:00.000Z" })
    );
    expect([...h.rows.values()][0]!.external_metadata).toMatchObject({
      mirrorMissingCount: 1,
      mirrorUnconfirmed: false
    });
    expect(h.list).toHaveBeenLastCalledWith(
      db,
      "account",
      "2026-10-21",
      "2026-11-22",
      "America/Los_Angeles"
    );
  });

  it("validates the entire batch before writing and refuses duplicate identities", async () => {
    const h = harness();
    await expect(
      h.run(
        batch({
          events: [
            ...batch().events,
            { ...batch().events[0]!, occurrenceKey: "bad", endsAt: "invalid" }
          ]
        })
      )
    ).rejects.toThrow("Invalid calendar mirror event");
    expect(h.upsert).not.toHaveBeenCalled();
    expect(() =>
      validateCalendarMirrorBatch(batch({ events: [...batch().events, ...batch().events] }))
    ).toThrow();
  });

  it("validates timed overlap in the source timezone and all-day overlap by calendar date", () => {
    const event = batch().events[0]!;
    const b = batch({ windowStart: "2026-10-21", windowEnd: "2026-10-22" });
    expect(() => validateCalendarMirrorBatch(b)).not.toThrow();
    expect(() =>
      validateCalendarMirrorBatch({
        ...b,
        events: [
          { ...event, startsAt: "2026-10-22T07:00:00.000Z", endsAt: "2026-10-22T08:00:00.000Z" }
        ]
      })
    ).toThrow();
    expect(() =>
      validateCalendarMirrorBatch({
        ...b,
        events: [
          {
            ...event,
            allDay: true,
            startsAt: "2026-10-21T00:00:00.000Z",
            endsAt: "2026-10-22T00:00:00.000Z"
          }
        ]
      })
    ).not.toThrow();
    expect(() =>
      validateCalendarMirrorBatch({
        ...b,
        events: [
          {
            ...event,
            allDay: true,
            startsAt: "2026-10-22T00:00:00.000Z",
            endsAt: "2026-10-23T00:00:00.000Z"
          }
        ]
      })
    ).toThrow();
  });

  it("separates calendar and occurrence identity without concatenation collisions", () => {
    expect(calendarMirrorExternalId("a,b", "c")).not.toBe(calendarMirrorExternalId("a", "b,c"));
  });
});
