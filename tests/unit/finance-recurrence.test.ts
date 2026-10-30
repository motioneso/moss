import { describe, expect, it } from "vitest";
import {
  billOccurrence,
  billOccurrences
} from "../../external-modules/finance/src/domain/recurrence.js";
describe("anchored bill projections", () => {
  it("clamps month ends without moving subsequent occurrences", () => {
    expect(
      billOccurrences({ anchorDate: "2026-01-31", cadence: "monthly" }, "2026-01-01", "2026-04-30")
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
  it("returns to leap day in later leap years", () => {
    const schedule = { anchorDate: "2024-02-29", cadence: "yearly" as const };
    expect(billOccurrence(schedule, 1)).toBe("2025-02-28");
    expect(billOccurrence(schedule, 4)).toBe("2028-02-29");
    expect(billOccurrence({ anchorDate: "2096-02-29", cadence: "yearly" }, 4)).toBe("2100-02-28");
  });
  it("keeps weekly dates stable across daylight saving boundaries", () => {
    expect(
      billOccurrences({ anchorDate: "2026-03-01", cadence: "weekly" }, "2026-03-01", "2026-03-22")
    ).toEqual(["2026-03-01", "2026-03-08", "2026-03-15", "2026-03-22"]);
  });
  it("uses inclusive windows and stop dates", () => {
    expect(
      billOccurrences(
        { anchorDate: "2026-12-25", cadence: "fortnightly", endDate: "2027-01-08" },
        "2027-01-08",
        "2027-02-01"
      )
    ).toEqual(["2027-01-08"]);
    expect(
      billOccurrences({ anchorDate: "2026-01-01", cadence: "once" }, "2026-02-01", "2026-03-01")
    ).toEqual([]);
  });
  it("handles early years and bounded long-running schedules", () => {
    expect(billOccurrence({ anchorDate: "0004-01-31", cadence: "monthly" }, 1)).toBe("0004-02-29");
    expect(
      billOccurrences({ anchorDate: "0001-01-01", cadence: "weekly" }, "9999-01-01", "9999-12-31")
        .length
    ).toBeGreaterThan(50);
    expect(billOccurrence({ anchorDate: "9999-12-31", cadence: "monthly" }, 1)).toBeNull();
  });
  it("rejects impossible dates, negative indices and excessive windows", () => {
    expect(() => billOccurrence({ anchorDate: "2026-02-30", cadence: "monthly" }, 0)).toThrow();
    expect(() => billOccurrence({ anchorDate: "2026-01-01", cadence: "weekly" }, -1)).toThrow();
    expect(() =>
      billOccurrences({ anchorDate: "2026-01-01", cadence: "monthly" }, "2026-01-01", "2028-01-01")
    ).toThrow();
  });
});
