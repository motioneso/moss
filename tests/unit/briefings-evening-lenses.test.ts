import { describe, expect, it } from "vitest";

import {
  filterEveningCalendar,
  localDayKey,
  localDayStartIso,
  partitionEveningTasks
} from "../../packages/briefings/src/evening-lenses.js";

const TZ = "America/Los_Angeles";
// 2026-07-02T21:00:00-07:00 (evening run time in LA) = 2026-07-03T04:00:00Z
const NOW = new Date("2026-07-03T04:00:00.000Z");

function task(over: Partial<Record<"id" | "title" | "doAt" | "dueAt" | "completedAt", string>>) {
  return { id: "t-" + (over.title ?? "x"), title: "task", status: "todo", ...over };
}

describe("localDayKey", () => {
  it("maps a UTC instant to the user's local day", () => {
    // 2026-07-03T02:30Z is still 2026-07-02 in LA (19:30 local)
    expect(localDayKey("2026-07-03T02:30:00.000Z", TZ)).toBe("2026-07-02");
  });
  it("fails closed on garbage", () => {
    expect(localDayKey("not-a-date", TZ)).toBeNull();
    expect(localDayKey(42, TZ)).toBeNull();
    expect(localDayKey("2026-07-02T12:00:00Z", "Not/AZone")).toBeNull();
  });
});

describe("localDayStartIso", () => {
  it("returns local midnight as a UTC instant", () => {
    expect(localDayStartIso(NOW, TZ)).toBe("2026-07-02T07:00:00.000Z");
    expect(localDayStartIso(NOW, "UTC")).toBe("2026-07-03T00:00:00.000Z");
  });
  it("uses the day's own offset on the fall-back DST day", () => {
    // Nov 1 2026 in LA starts at 00:00 PDT (07:00Z) and ends in PST.
    expect(localDayStartIso(new Date("2026-11-01T20:00:00.000Z"), TZ)).toBe(
      "2026-11-01T07:00:00.000Z"
    );
  });
  it("returns null for an unknown zone", () => {
    expect(localDayStartIso(NOW, "Not/AZone")).toBeNull();
  });
});

describe("partitionEveningTasks", () => {
  it("splits completed-today / slipped / carrying-forward on the user's local day", () => {
    const lenses = partitionEveningTasks({
      completedItems: [
        // 23:59 local today → completed today
        task({ title: "done-today", completedAt: "2026-07-03T06:59:00.000Z" }),
        // 00:01 local TOMORROW → excluded even though within a 48h lookback
        task({ title: "done-tomorrow", completedAt: "2026-07-03T07:01:00.000Z" })
      ],
      openItems: [
        task({ title: "slipped-due", dueAt: "2026-07-03T01:00:00.000Z" }), // today local
        task({ title: "slipped-do", doAt: "2026-07-02T20:00:00.000Z" }), // today local
        task({ title: "carrying", dueAt: "2026-06-30T12:00:00.000Z" }), // before today
        task({ title: "future", dueAt: "2026-07-10T12:00:00.000Z" }), // not in any lens
        task({ title: "dateless" }) // not in any lens
      ],
      now: NOW,
      timeZone: TZ
    });
    expect(lenses.completedToday.map((t) => t.title)).toEqual(["done-today"]);
    expect(lenses.slipped.map((t) => t.title).sort()).toEqual(["slipped-do", "slipped-due"]);
    expect(lenses.carryingForward.map((t) => t.title)).toEqual(["carrying"]);
  });
});

describe("filterEveningCalendar", () => {
  it("keeps tomorrow's events and today's still-ahead events, drops the rest", () => {
    const kept = filterEveningCalendar(
      [
        { startsAt: "2026-07-02T16:00:00.000Z", title: "this-morning" }, // today, already past
        { startsAt: "2026-07-03T05:00:00.000Z", title: "tonight" }, // today local, ahead of now
        { startsAt: "2026-07-03T17:00:00.000Z", title: "tomorrow-mtg" }, // tomorrow local
        { startsAt: "2026-07-04T17:00:00.000Z", title: "day-after" }, // beyond tomorrow
        { title: "no-start" }
      ],
      NOW,
      TZ
    );
    expect(kept.map((e) => e.title)).toEqual(["tonight", "tomorrow-mtg"]);
  });
  it("compares all-day events by calendar date, not by local instant", () => {
    // Evening of 2026-07-02 in LA. All-day rows are UTC midnights with an exclusive end date.
    const kept = filterEveningCalendar(
      [
        {
          allDay: true,
          startsAt: "2026-07-03T00:00:00.000Z",
          endsAt: "2026-07-04T00:00:00.000Z",
          title: "tomorrow-all-day"
        },
        {
          allDay: true,
          startsAt: "2026-07-04T00:00:00.000Z",
          endsAt: "2026-07-05T00:00:00.000Z",
          title: "day-after-all-day"
        },
        {
          allDay: true,
          startsAt: "2026-07-02T00:00:00.000Z",
          endsAt: "2026-07-03T00:00:00.000Z",
          title: "today-all-day"
        },
        {
          allDay: true,
          startsAt: "2026-07-01T00:00:00.000Z",
          endsAt: "2026-07-04T00:00:00.000Z",
          title: "multi-day-spanning-tomorrow"
        }
      ],
      NOW,
      TZ
    );
    expect(kept.map((e) => e.title)).toEqual(["tomorrow-all-day", "multi-day-spanning-tomorrow"]);
  });
  it("resolves 'tomorrow' correctly across the fall-back DST boundary", () => {
    // 2026-11-01 in LA is 25h long. Evening of Oct 31, 21:00 PDT = Nov 1 04:00Z.
    const dstNow = new Date("2026-11-01T04:00:00.000Z");
    const kept = filterEveningCalendar(
      [{ startsAt: "2026-11-01T20:00:00.000Z", title: "nov-1-noon" }],
      dstNow,
      TZ
    );
    expect(kept.map((e) => e.title)).toEqual(["nov-1-noon"]);
  });
});
