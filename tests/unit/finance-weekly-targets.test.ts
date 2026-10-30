import { describe, it, expect } from "vitest";
import {
  targetProgress,
  type CategoryTarget
} from "../../external-modules/finance/src/domain/targets.js";
const target: CategoryTarget = {
  categoryId: "groceries",
  effectiveMonth: "2026-10",
  kind: "weekly",
  amountCents: 2501,
  dueDate: null,
  weekday: 5
};
describe("full-month weekly contribution targets", () => {
  it("counts five Fridays in October without treating carry as new contributions", () => {
    const progress = targetProgress(
      target,
      { assignedCents: 5000, activityCents: 1000, availableCents: 99999 },
      "2026-10",
      "2026-10-30"
    );
    expect(progress.remainingCents).toBe(7505);
    expect(progress).toMatchObject({
      progressCents: 5000,
      suggestedCents: 7505,
      weekly: { weekday: 5, occurrences: 5, totalCents: 12505 }
    });
  });
  it("recalculates four Fridays in February from the same weekly amount", () => {
    const progress = targetProgress(
      target,
      { assignedCents: 0, activityCents: 0, availableCents: 99999 },
      "2026-02",
      "2026-02-01"
    );
    expect(progress.remainingCents).toBe(10004);
    expect(progress).toMatchObject({ weekly: { occurrences: 4, totalCents: 10004 } });
  });
  it("does not reopen a funded contribution when the money is spent", () => {
    const progress = targetProgress(
      target,
      { assignedCents: 12505, activityCents: 12505, availableCents: 0 },
      "2026-10",
      "2026-10-30"
    );
    expect(progress.remainingCents).toBe(0);
    expect(progress.status).toBe("reached");
  });
});

import {
  countWeekdays,
  weeklyTargetPeriod,
  MAX_WEEKLY_CENTS
} from "../../external-modules/finance/src/domain/weekly-targets.js";
describe("weekly target calendar and precision bounds", () => {
  it.each([
    ["0001-01", [4, 5, 5, 5, 4, 4, 4]],
    ["2024-02", [4, 4, 4, 4, 5, 4, 4]],
    ["2026-02", [4, 4, 4, 4, 4, 4, 4]],
    ["2026-10", [4, 4, 4, 4, 5, 5, 5]],
    ["2100-02", [4, 4, 4, 4, 4, 4, 4]],
    ["9999-12", [4, 4, 4, 5, 5, 5, 4]]
  ] as const)(
    "counts each weekday in %s (independent Gregorian calendar examples)",
    (month, counts) => {
      expect(Array.from({ length: 7 }, (_, weekday) => countWeekdays(month, weekday))).toEqual(
        counts
      );
    }
  );
  it.each(["0000-01", "2026-00", "2026-13", "2026-2", "2026-02-01"])(
    "refuses invalid month %s",
    (month) => {
      expect(() => countWeekdays(month, 5)).toThrow();
    }
  );
  it.each([-1, 7, 1.5, NaN])("refuses invalid weekday %s", (weekday) => {
    expect(() => countWeekdays("2026-10", weekday)).toThrow();
  });
  it("uses exact hundredths and refuses an amount that could overflow a five-occurrence month", () => {
    expect(weeklyTargetPeriod("2026-10", 5, 2501)).toEqual({
      weekday: 5,
      occurrences: 5,
      totalCents: 12505
    });
    expect(weeklyTargetPeriod("2026-10", 5, MAX_WEEKLY_CENTS).totalCents).toBe(9007199254740990);
    for (const amount of [0, -1, 1.1, MAX_WEEKLY_CENTS + 1, Number.MAX_SAFE_INTEGER + 1])
      expect(() => weeklyTargetPeriod("2026-02", 5, amount)).toThrow();
  });
});
