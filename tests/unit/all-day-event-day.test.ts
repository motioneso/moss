import { afterEach, describe, expect, it, vi } from "vitest";

import { eventCoversDay } from "@moss/shared";
import { composeBriefing } from "../../packages/briefings/src/compose.js";
import { isToday } from "../../apps/web/src/today/today-labels.js";
import { definition, fakeScopedDb, makeFakeDeps, runInput } from "./briefings-compose.harness.js";

// #2503: all-day events are stored as UTC midnights with an exclusive end date. They
// are calendar dates, so they must not move when converted into the viewer's zone.

const ALL_DAY = {
  id: "ad-1",
  title: "Holiday",
  startsAt: "2026-06-13T00:00:00.000Z",
  endsAt: "2026-06-14T00:00:00.000Z",
  allDay: true
};

describe("eventCoversDay", () => {
  it.each(["America/Los_Angeles", "UTC", "Pacific/Auckland"])(
    "keeps a one-day all-day event on its own date in %s",
    (tz) => {
      expect(eventCoversDay(ALL_DAY, "2026-06-13", tz)).toBe(true);
      expect(eventCoversDay(ALL_DAY, "2026-06-12", tz)).toBe(false);
      // The end date is exclusive.
      expect(eventCoversDay(ALL_DAY, "2026-06-14", tz)).toBe(false);
    }
  );

  it("covers every date of a multi-day all-day event except the exclusive end", () => {
    const trip = { ...ALL_DAY, endsAt: "2026-06-16T00:00:00.000Z" };
    for (const day of ["2026-06-13", "2026-06-14", "2026-06-15"]) {
      expect(eventCoversDay(trip, day, "America/Los_Angeles")).toBe(true);
    }
    expect(eventCoversDay(trip, "2026-06-16", "America/Los_Angeles")).toBe(false);
  });

  it("still places timed events by the viewer's local day", () => {
    const timed = {
      startsAt: "2026-06-14T03:00:00.000Z",
      endsAt: "2026-06-14T04:00:00.000Z",
      allDay: false
    };
    expect(eventCoversDay(timed, "2026-06-13", "America/Los_Angeles")).toBe(true);
    expect(eventCoversDay(timed, "2026-06-14", "America/Los_Angeles")).toBe(false);
    expect(eventCoversDay(timed, "2026-06-14", "UTC")).toBe(true);
  });
});

describe("Today screen day check", () => {
  afterEach(() => vi.useRealTimers());

  it("counts an all-day event as today west of UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T19:00:00.000Z"));
    const event = { ...ALL_DAY } as never;
    expect(isToday(event, "America/Los_Angeles")).toBe(true);
  });

  it("counts an all-day event as today east of UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T02:00:00.000Z"));
    expect(isToday({ ...ALL_DAY } as never, "Pacific/Auckland")).toBe(true);
  });
});

describe("briefing meeting count", () => {
  it("counts an all-day event on its date for a west-of-UTC report", async () => {
    const deps = makeFakeDeps({ calendarEvents: [ALL_DAY] });
    const result = await composeBriefing(
      fakeScopedDb,
      definition({
        schedule_metadata: { targetTime: "06:00", timezone: "America/Los_Angeles" }
      }),
      runInput,
      deps
    );
    expect(result.sourceMetadata.calendarTodayCount).toBe(1);
  });
});
