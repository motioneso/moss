import { describe, expect, it } from "vitest";

import type { CalendarEventDto } from "@moss/shared";

import {
  dateRangeLabel,
  dayKey,
  dtoToViewEvent,
  groupEventsByDay,
  plainDate,
  type CalendarViewEvent
} from "../apps/web/src/calendar/calendar-model.js";

function dto(over: Partial<CalendarEventDto>): CalendarEventDto {
  return {
    id: "e1",
    title: "Trip",
    startsAt: "2026-10-05T00:00:00.000Z",
    endsAt: "2026-10-06T00:00:00.000Z",
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: "x",
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over
  } as CalendarEventDto;
}

function view(over: Partial<CalendarEventDto>): CalendarViewEvent {
  const v = dtoToViewEvent(dto(over), TZ);
  if (!v) throw new Error("bad dto");
  return v;
}

const TZ = "America/Los_Angeles";
const LOCALE = { timezone: TZ, region: "en-US", dateFormat: "24" } as const;
const key = (y: number, m: number, d: number) => dayKey(plainDate(y, m - 1, d));

describe("groupEventsByDay multi-day events", () => {
  it("puts a 3-day all-day event on every day up to its exclusive end", () => {
    const map = groupEventsByDay(
      [
        view({
          allDay: true,
          startsAt: "2026-10-05T00:00:00.000Z",
          endsAt: "2026-10-08T00:00:00.000Z"
        })
      ],
      TZ
    );
    expect([...map.keys()].sort()).toEqual(
      [key(2026, 10, 5), key(2026, 10, 6), key(2026, 10, 7)].sort()
    );
  });

  it("keeps a single-day all-day event on one day", () => {
    const map = groupEventsByDay(
      [
        view({
          allDay: true,
          startsAt: "2026-10-05T00:00:00.000Z",
          endsAt: "2026-10-06T00:00:00.000Z"
        })
      ],
      TZ
    );
    expect([...map.keys()]).toEqual([key(2026, 10, 5)]);
  });

  it("adds a segment on each day an overnight timed event touches", () => {
    // Oct 5 22:00 to Oct 7 08:30 in Los Angeles (UTC-7).
    const start = new Date("2026-10-06T05:00:00.000Z");
    const end = new Date("2026-10-07T15:30:00.000Z");
    const map = groupEventsByDay(
      [view({ startsAt: start.toISOString(), endsAt: end.toISOString() })],
      TZ
    );
    const seg = (d: number) => map.get(key(2026, 10, d))?.[0];
    expect(seg(5)).toMatchObject({ startMin: 22 * 60, endMin: 1440 });
    expect(seg(6)).toMatchObject({ startMin: 0, endMin: 1440 });
    expect(seg(7)).toMatchObject({ startMin: 0, endMin: 8 * 60 + 30 });
    expect(seg(5)?.startsAt.getTime()).toBe(start.getTime());
    expect(seg(7)?.endsAt.getTime()).toBe(end.getTime());
  });

  it("does not add a day when a timed event ends exactly at midnight", () => {
    const map = groupEventsByDay(
      [
        view({
          startsAt: "2026-10-06T03:00:00.000Z",
          endsAt: "2026-10-06T07:00:00.000Z"
        })
      ],
      TZ
    );
    expect([...map.keys()]).toEqual([key(2026, 10, 5)]);
    expect(map.get(key(2026, 10, 5))?.[0]).toMatchObject({ startMin: 20 * 60, endMin: 1440 });
  });
});

describe("dateRangeLabel for multi-day all-day events", () => {
  it("starts from the real start date, not the clicked day", () => {
    const map = groupEventsByDay(
      [
        view({
          allDay: true,
          startsAt: "2026-10-05T00:00:00.000Z",
          endsAt: "2026-10-08T00:00:00.000Z"
        })
      ],
      TZ
    );
    const clicked = map.get(key(2026, 10, 7))?.[0];
    if (!clicked) throw new Error("missing segment");
    const expected = dateRangeLabel(
      view({
        allDay: true,
        startsAt: "2026-10-05T00:00:00.000Z",
        endsAt: "2026-10-08T00:00:00.000Z"
      }),
      LOCALE
    );
    expect(dateRangeLabel(clicked, LOCALE)).toBe(expected);
  });
});
