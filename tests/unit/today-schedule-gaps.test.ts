import { describe, expect, it } from "vitest";

import type { LocaleSettingsDto } from "@moss/shared";

import type { DayItem } from "../../apps/web/src/today/day-plan-view-model.js";
import {
  buildScheduleGaps,
  SCHEDULE_BREAK_MAX_MINUTES,
  SCHEDULE_GAP_MIN_MINUTES
} from "../../apps/web/src/today/day-plan-gaps.js";

const locale: LocaleSettingsDto = {
  timezone: "America/Los_Angeles",
  region: "en-US",
  dateFormat: "12"
};

const DAY = "2026-06-30";

function item(overrides: Partial<DayItem> & { readonly key: string }): DayItem {
  return {
    kind: "task",
    kindLabel: null,
    state: "committed",
    label: "On the calendar",
    title: `Item ${overrides.key}`,
    startsAt: null,
    endsAt: null,
    durationMinutes: null,
    taskId: null,
    unavailable: false,
    eventId: null,
    location: null,
    ...overrides
  };
}

/** Local (Pacific) time on the fixed test day, expressed as a UTC ISO string. */
function at(time: string): string {
  return new Date(`${DAY}T${time}:00-07:00`).toISOString();
}

/** A known-end item: start plus a positive duration. */
function timed(key: string, start: string, endOrDurationMinutes: string | number): DayItem {
  if (typeof endOrDurationMinutes === "number") {
    return item({ key, startsAt: at(start), durationMinutes: endOrDurationMinutes });
  }
  return item({ key, startsAt: at(start), endsAt: at(endOrDurationMinutes) });
}

/** An unknown-end item: a start with neither endsAt nor a positive duration. */
function openStart(key: string, start: string): DayItem {
  return item({ key, startsAt: at(start), durationMinutes: null });
}

function unscheduled(key: string): DayItem {
  return item({ key, startsAt: null });
}

describe("buildScheduleGaps - arbiter test table", () => {
  it("case 1: no items produces nothing", () => {
    expect(buildScheduleGaps([], locale)).toEqual({ rows: [], closing: null });
  });

  it("case 2: a single timed item produces only a closing line", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30)], locale);
    expect(result.rows).toEqual([]);
    expect(result.closing?.afterItemKey).toBe("a");
    expect(result.closing?.text).toContain("9:30");
  });

  it("case 3: a 15-minute gap reads as a break, placed after A", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30), timed("b", "09:45", 15)], locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "break", afterItemKey: "a" });
    expect(result.closing?.text).toContain("10:00");
  });

  it("case 4: an open-ended gap reads as open time, placed after A", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30), timed("b", "10:30", 30)], locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "open", afterItemKey: "a" });
    expect(result.closing?.text).toContain("11:00");
  });

  it("case 5a: a 30-minute gap is a break", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30), timed("b", "10:00", 30)], locale);
    expect(result.rows[0]).toMatchObject({ kind: "break", afterItemKey: "a" });
    expect(result.closing?.text).toContain("10:30");
  });

  it("case 5b: a 31-minute gap is open time", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30), timed("b", "10:01", 30)], locale);
    expect(result.rows[0]).toMatchObject({ kind: "open", afterItemKey: "a" });
    expect(result.closing?.text).toContain("10:31");
  });

  it("case 6a: back-to-back items produce no gap", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30), timed("b", "09:30", 30)], locale);
    expect(result.rows).toEqual([]);
    expect(result.closing?.text).toContain("10:00");
  });

  it("case 6b: an item fully overlapping another produces no gap", () => {
    const result = buildScheduleGaps(
      [timed("a", "09:00", "10:00"), timed("b", "09:30", "10:00")],
      locale
    );
    expect(result.rows).toEqual([]);
    expect(result.closing?.text).toContain("10:00");
  });

  it("case 7: a gap under the 1-minute floor produces no row, the floor itself does", () => {
    const startA = at("09:00");
    const endA = new Date(Date.parse(startA) + 30 * 60000).toISOString(); // 9:30
    const justUnder = new Date(
      Date.parse(endA) + SCHEDULE_GAP_MIN_MINUTES * 60000 - 1000
    ).toISOString();
    const atFloor = new Date(Date.parse(endA) + SCHEDULE_GAP_MIN_MINUTES * 60000).toISOString();

    const under = buildScheduleGaps(
      [
        item({ key: "a", startsAt: startA, durationMinutes: 30 }),
        item({ key: "b", startsAt: justUnder, durationMinutes: 30 })
      ],
      locale
    );
    expect(under.rows).toEqual([]);

    const atBoundary = buildScheduleGaps(
      [
        item({ key: "a", startsAt: startA, durationMinutes: 30 }),
        item({ key: "c", startsAt: atFloor, durationMinutes: 30 })
      ],
      locale
    );
    expect(atBoundary.rows).toHaveLength(1);
  });

  it("case 8: an unknown-end item merges into the chain instead of acting as a barrier", () => {
    const result = buildScheduleGaps(
      [timed("a", "09:00", 30), openStart("u", "09:45"), timed("b", "11:00", 30)],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "break", afterItemKey: "a" })]);
    expect(result.closing?.afterItemKey).toBe("b");
    expect(result.closing?.text).toContain("11:30");
  });

  it("case 8b: an unknown-end item with no later start stays open, so there is no closing line", () => {
    const result = buildScheduleGaps([timed("a", "09:00", 30), openStart("u", "10:00")], locale);
    expect(result.rows).toEqual([expect.objectContaining({ kind: "break", afterItemKey: "a" })]);
    expect(result.closing).toBeNull();
  });

  it("case 9: unscheduled items are dropped regardless of position", () => {
    const result = buildScheduleGaps(
      [unscheduled("x"), timed("a", "09:00", 30), unscheduled("y"), timed("b", "10:30", 30)],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "open", afterItemKey: "a" })]);
    expect(result.closing?.text).toContain("11:00");
  });

  it("case 10: items out of input order are sorted by start before gaps are computed", () => {
    const result = buildScheduleGaps([timed("b", "10:30", 30), timed("a", "09:00", 30)], locale);
    expect(result.rows).toEqual([expect.objectContaining({ kind: "open", afterItemKey: "a" })]);
    expect(result.closing?.text).toContain("11:00");
  });

  it("case 11: a long item containing shorter ones produces no fabricated gap", () => {
    const result = buildScheduleGaps(
      [timed("a", "09:00", "12:00"), timed("b", "10:00", 30), timed("c", "11:00", 30)],
      locale
    );
    expect(result.rows).toEqual([]);
    expect(result.closing?.afterItemKey).toBe("c");
    expect(result.closing?.text).toContain("12:00");
  });

  it("case 12: a gap after the containing item's end is placed after the last nested item", () => {
    const result = buildScheduleGaps(
      [
        timed("a", "09:00", "12:00"),
        timed("b", "10:00", 30),
        timed("c", "11:00", 30),
        timed("d", "12:15", 30)
      ],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "break", afterItemKey: "c" })]);
    expect(result.closing?.text).toContain("12:45");
  });

  it("case 13: a chained overlap tracks the furthest end, not the previous neighbor's", () => {
    const result = buildScheduleGaps(
      [
        timed("a", "09:00", "10:00"),
        timed("b", "09:45", "11:00"),
        timed("c", "10:30", "11:30"),
        timed("d", "12:00", 30)
      ],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "break", afterItemKey: "c" })]);
    expect(result.closing?.text).toContain("12:30");
  });

  it("case 14: an unknown-end item nested inside a long item produces no fabricated gap (round 2, finding 1)", () => {
    const result = buildScheduleGaps(
      [
        timed("a", "09:00", "12:00"),
        openStart("u", "09:30"),
        timed("c", "10:00", 30),
        timed("d", "11:00", 30)
      ],
      locale
    );
    expect(result.rows).toEqual([]);
    expect(result.closing?.afterItemKey).toBe("d");
    expect(result.closing?.text).toContain("12:00");
  });

  it("case 15: case 14 plus a later item produces one open-time gap after the last nested item", () => {
    const result = buildScheduleGaps(
      [
        timed("a", "09:00", "12:00"),
        openStart("u", "09:30"),
        timed("c", "10:00", 30),
        timed("d", "11:00", 30),
        timed("e", "13:00", 30)
      ],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "open", afterItemKey: "d" })]);
    expect(result.closing?.text).toContain("1:30");
  });

  it("case 16: a gap after a contained item's neighbor is placed after that neighbor, not the container (round 2, finding 2)", () => {
    const result = buildScheduleGaps(
      [timed("a", "09:00", "12:00"), timed("b", "10:00", 30), timed("c", "13:00", 30)],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "open", afterItemKey: "b" })]);
    expect(result.closing?.afterItemKey).toBe("c");
    expect(result.closing?.text).toContain("1:30");
  });

  it("case 17: among same-start items, an unknown end resolves against the next distinct start", () => {
    const result = buildScheduleGaps(
      [
        timed("a", "09:00", 30),
        openStart("u", "10:00"),
        timed("v", "10:00", 15),
        timed("b", "11:00", 30)
      ],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "break", afterItemKey: "a" })]);
    expect(result.closing?.text).toContain("11:30");
  });

  it("case 18: an unknown-end item nested inside a long item leaves the schedule open, no closing line", () => {
    const result = buildScheduleGaps(
      [timed("a", "09:00", "17:00"), openStart("u", "10:00")],
      locale
    );
    expect(result.rows).toEqual([]);
    expect(result.closing).toBeNull();
  });

  it("case 19: chained unknown-end items each resolve against the next distinct start", () => {
    const result = buildScheduleGaps(
      [
        openStart("u", "09:00"),
        openStart("v", "10:00"),
        timed("a", "11:00", 30),
        timed("b", "12:30", 30)
      ],
      locale
    );
    expect(result.rows).toEqual([expect.objectContaining({ kind: "open", afterItemKey: "a" })]);
    expect(result.closing?.text).toContain("1:00");
  });
});

describe("buildScheduleGaps - additional coverage kept from the prior suite", () => {
  it("pins the break/open boundary to the named constant", () => {
    const startA = at("18:00");
    const endA = new Date(Date.parse(startA) + 60 * 60000).toISOString();

    const atBoundary = new Date(
      Date.parse(endA) + SCHEDULE_BREAK_MAX_MINUTES * 60000
    ).toISOString();
    const overBoundary = new Date(
      Date.parse(endA) + (SCHEDULE_BREAK_MAX_MINUTES + 1) * 60000
    ).toISOString();

    const atResult = buildScheduleGaps(
      [
        item({ key: "a", startsAt: startA, durationMinutes: 60 }),
        item({ key: "b", startsAt: atBoundary, durationMinutes: 30 })
      ],
      locale
    );
    expect(atResult.rows[0]?.kind).toBe("break");

    const overResult = buildScheduleGaps(
      [
        item({ key: "a", startsAt: startA, durationMinutes: 60 }),
        item({ key: "c", startsAt: overBoundary, durationMinutes: 30 })
      ],
      locale
    );
    expect(overResult.rows[0]?.kind).toBe("open");
  });

  it("reports no closing line when the last item has no computable end and no later start", () => {
    const result = buildScheduleGaps([timed("a", "18:00", 30), openStart("b", "18:45")], locale);
    expect(result.closing).toBeNull();
  });

  it("sorts internally by resolved start even when the input is out of order", () => {
    const result = buildScheduleGaps([timed("b", "18:45", 30), timed("a", "18:00", 30)], locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.afterItemKey).toBe("a");
  });
});
