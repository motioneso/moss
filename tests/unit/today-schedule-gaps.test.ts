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

describe("buildScheduleGaps", () => {
  it("returns nothing for an empty schedule", () => {
    expect(buildScheduleGaps([], locale)).toEqual({ rows: [], closing: null });
  });

  it("returns only a closing line for a single timed item", () => {
    const items = [
      item({ key: "a", startsAt: "2026-06-30T15:00:00.000Z", durationMinutes: 30 })
    ];
    const result = buildScheduleGaps(items, locale);
    expect(result.rows).toEqual([]);
    expect(result.closing).not.toBeNull();
    expect(result.closing?.afterItemKey).toBe("a");
    expect(result.closing?.text).toContain("No more commitments after");
  });

  it("reads a 15-minute gap as a break", () => {
    const items = [
      item({ key: "a", startsAt: "2026-06-30T17:00:00.000Z", durationMinutes: 90 }), // ends 18:30
      item({ key: "b", startsAt: "2026-06-30T18:45:00.000Z", durationMinutes: 45 }) // 15 min gap
    ];
    const result = buildScheduleGaps(items, locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "break",
      afterItemKey: "a",
      label: "A break before the next block",
      startsAt: "2026-06-30T18:30:00.000Z",
      endsAt: "2026-06-30T18:45:00.000Z"
    });
  });

  it("reads a 60-minute gap as open time", () => {
    const items = [
      item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 60 }), // ends 19:00
      item({ key: "b", startsAt: "2026-06-30T20:00:00.000Z", durationMinutes: 60 }) // 60 min gap
    ];
    const result = buildScheduleGaps(items, locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "open",
      afterItemKey: "a",
      label: "Open time"
    });
  });

  it("pins the break/open boundary to the named constant", () => {
    const startA = "2026-06-30T18:00:00.000Z";
    const endA = new Date(Date.parse(startA) + 60 * 60000).toISOString(); // 19:00

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

  it("produces no row for back-to-back or overlapping items", () => {
    const backToBack = buildScheduleGaps(
      [
        item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 60 }), // ends 19:00
        item({ key: "b", startsAt: "2026-06-30T19:00:00.000Z", durationMinutes: 30 })
      ],
      locale
    );
    expect(backToBack.rows).toEqual([]);

    const overlapping = buildScheduleGaps(
      [
        item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 90 }), // ends 19:30
        item({ key: "b", startsAt: "2026-06-30T19:00:00.000Z", durationMinutes: 30 })
      ],
      locale
    );
    expect(overlapping.rows).toEqual([]);
  });

  it("treats a gap under the noise floor as no gap, and the floor itself as a gap", () => {
    const endA = "2026-06-30T19:00:00.000Z";
    const justUnder = new Date(
      Date.parse(endA) + SCHEDULE_GAP_MIN_MINUTES * 60000 - 1000
    ).toISOString();
    const atFloor = new Date(Date.parse(endA) + SCHEDULE_GAP_MIN_MINUTES * 60000).toISOString();

    const underResult = buildScheduleGaps(
      [
        item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 60 }),
        item({ key: "b", startsAt: justUnder, durationMinutes: 30 })
      ],
      locale
    );
    expect(underResult.rows).toEqual([]);

    const atFloorResult = buildScheduleGaps(
      [
        item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 60 }),
        item({ key: "c", startsAt: atFloor, durationMinutes: 30 })
      ],
      locale
    );
    expect(atFloorResult.rows).toHaveLength(1);
  });

  it("excludes an item with no computable end from the gap chain instead of inventing one", () => {
    // a ends 18:30. b has a start but no duration/end - cannot be bridged from or to.
    // c starts 20:00. The only real gap knowledge is a->b's start (not used) and
    // nothing about b's own end, so no gap row should reference b at all.
    const items = [
      item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 30 }),
      item({ key: "b", startsAt: "2026-06-30T18:45:00.000Z", durationMinutes: null }),
      item({ key: "c", startsAt: "2026-06-30T20:00:00.000Z", durationMinutes: 30 })
    ];
    const result = buildScheduleGaps(items, locale);
    expect(result.rows.every((row) => row.afterItemKey !== "b")).toBe(true);
    expect(result.rows.some((row) => row.afterItemKey === "b")).toBe(false);
    // Closing line follows the last item with a computable end: c.
    expect(result.closing?.afterItemKey).toBe("c");
  });

  it("ignores unscheduled items regardless of position", () => {
    const items = [
      item({ key: "unscheduled", startsAt: null, durationMinutes: null }),
      item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 30 }), // ends 18:30
      item({ key: "b", startsAt: "2026-06-30T18:45:00.000Z", durationMinutes: 30 }) // 15 min gap
    ];
    const result = buildScheduleGaps(items, locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.afterItemKey).toBe("a");
  });

  it("sorts internally by resolved start even when the input is out of order", () => {
    const items = [
      item({ key: "b", startsAt: "2026-06-30T18:45:00.000Z", durationMinutes: 30 }),
      item({ key: "a", startsAt: "2026-06-30T18:00:00.000Z", durationMinutes: 30 })
    ];
    const result = buildScheduleGaps(items, locale);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.afterItemKey).toBe("a");
  });
});
