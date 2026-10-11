// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CalendarEventDto } from "@moss/shared";
import {
  dayKey,
  dtoToViewEvent,
  groupEventsByDay,
  loadPersistedCursor,
  loadPersistedView,
  loadPersistedWorkWeek,
  plainDate,
  type CalendarViewEvent
} from "../../apps/web/src/calendar/calendar-model.js";

// The machine runs in UTC; the person lives in a western timezone. All-day events must
// still land on their own date, and timed events on the person's day.
process.env.TZ = "UTC";
const TZ = "America/Los_Angeles";

function makeDto(overrides: Partial<CalendarEventDto>): CalendarEventDto {
  return {
    id: "evt-1",
    connectorAccountId: "conn-1",
    ownerUserId: "user-1",
    title: "Event",
    startsAt: "2026-06-20T16:00:00.000Z",
    endsAt: "2026-06-20T17:00:00.000Z",
    location: null,
    summary: null,
    bodyExcerpt: null,
    externalId: "ext-1",
    isMossBlock: false,
    allDay: false,
    attendeeCount: 0,
    status: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

describe("dtoToViewEvent all-day timezone bucketing", () => {
  it("anchors a UTC-midnight all-day event to its UTC date, not the local previous day", () => {
    // 2026-06-20T00:00:00Z reads as Jun 19 17:00 in America/Los_Angeles.
    const view = dtoToViewEvent(
      makeDto({
        id: "allday",
        allDay: true,
        startsAt: "2026-06-20T00:00:00.000Z",
        endsAt: "2026-06-21T00:00:00.000Z"
      }),
      TZ
    );
    expect(view).not.toBeNull();
    // June is month index 5; the event must land on the 20th, not the 19th.
    expect(dayKey(view!.date)).toBe("2026-06-20");
  });

  it("groups the all-day event under the Jun 20 cell key used by the day/month views", () => {
    const view = dtoToViewEvent(
      makeDto({
        id: "allday",
        allDay: true,
        startsAt: "2026-06-20T00:00:00.000Z",
        endsAt: "2026-06-21T00:00:00.000Z"
      }),
      TZ
    ) as CalendarViewEvent;
    const byDay = groupEventsByDay([view], TZ);
    // A visible day cell for Jun 20 is a plain date; its lookup key must match.
    const jun20CellKey = dayKey(plainDate(2026, 5, 20));
    expect(byDay.get(jun20CellKey)).toHaveLength(1);
    expect(byDay.get(dayKey(plainDate(2026, 5, 19)))).toBeUndefined();
  });

  it("keeps timed events on the person's day of the start instant", () => {
    // 2026-06-20T16:00:00Z is Jun 20 09:00 in America/Los_Angeles.
    const view = dtoToViewEvent(makeDto({ allDay: false }), TZ) as CalendarViewEvent;
    expect(dayKey(view.date)).toBe("2026-06-20");
    expect(view.startMin).toBe(9 * 60);
  });
});

describe("legacy jarvis.cal.* localStorage migration", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("falls back to the legacy view key and migrates it to the new key", () => {
    localStorage.setItem("jarvis.cal.view", "week");
    expect(loadPersistedView()).toBe("week");
    expect(localStorage.getItem("moss.cal.view")).toBe("week");
    expect(localStorage.getItem("jarvis.cal.view")).toBeNull();
  });

  it("prefers an existing new-key value over the legacy key", () => {
    localStorage.setItem("jarvis.cal.view", "week");
    localStorage.setItem("moss.cal.view", "month");
    expect(loadPersistedView()).toBe("month");
    // The legacy key is left alone once the new key already has a value.
    expect(localStorage.getItem("jarvis.cal.view")).toBe("week");
  });

  it("migrates the legacy cursor key", () => {
    localStorage.setItem("jarvis.cal.cursor", "2030-06-06T16:00:00.000Z");
    const cursor = loadPersistedCursor();
    expect(cursor?.toISOString()).toBe("2030-06-06T00:00:00.000Z");
    expect(localStorage.getItem("moss.cal.cursor")).toBe("2030-06-06T16:00:00.000Z");
    expect(localStorage.getItem("jarvis.cal.cursor")).toBeNull();
  });

  it("migrates the legacy workweek key", () => {
    localStorage.setItem("jarvis.cal.workweek", "1");
    expect(loadPersistedWorkWeek()).toBe(true);
    expect(localStorage.getItem("moss.cal.workweek")).toBe("1");
    expect(localStorage.getItem("jarvis.cal.workweek")).toBeNull();
  });

  it("defaults when neither key is present", () => {
    expect(loadPersistedView()).toBe("day");
    expect(loadPersistedCursor()).toBeNull();
    expect(loadPersistedWorkWeek()).toBe(false);
  });
});
