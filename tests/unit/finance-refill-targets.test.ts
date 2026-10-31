import { describe, it, expect } from "vitest";
import {
  targetProgress,
  type CategoryTarget
} from "../../external-modules/finance/src/domain/targets.js";
const refill: CategoryTarget = {
  categoryId: "groceries",
  effectiveMonth: "2026-10",
  kind: "refill",
  amountCents: 10000,
  dueDate: null
};
describe("monthly refill plan", () => {
  it.each([
    [{ assignedCents: 3000, activityCents: 2500, availableCents: 2500 }, 5000, 5000],
    [{ assignedCents: 3000, activityCents: 7500, availableCents: -2500 }, 5000, 5000],
    [{ assignedCents: 3000, activityCents: -1000, availableCents: 6000 }, 5000, 5000],
    [{ assignedCents: -500, activityCents: 700, availableCents: 800 }, 1500, 8500],
    [{ assignedCents: 0, activityCents: 0, availableCents: 12000 }, 12000, 0],
    [{ assignedCents: -1000, activityCents: 0, availableCents: -1000 }, 0, 11000]
  ] as const)(
    "counts carry and assignments independently of current spending/refunds: %j",
    (state, progress, remaining) => {
      expect(targetProgress(refill, state, "2026-10", "2026-10-30")).toMatchObject({
        progressCents: progress,
        remainingCents: remaining,
        suggestedCents: remaining,
        status: remaining === 0 ? "reached" : "in-progress"
      });
    }
  );
  it("does not silently convert monthly contribution or dated balance targets", () => {
    const state = { assignedCents: 3000, activityCents: 2500, availableCents: 2500 };
    const progress = (kind: CategoryTarget["kind"]) =>
      targetProgress(
        { ...refill, kind, dueDate: kind === "balance" ? "2026-10-31" : null },
        state,
        "2026-10",
        "2026-10-30"
      );
    expect(progress("monthly").remainingCents).toBe(7000);
    expect(progress("balance").remainingCents).toBe(7500);
    expect(progress("refill").remainingCents).toBe(5000);
  });
  it("starts with zero contributions for an absent envelope", () => {
    expect(targetProgress(refill, undefined, "2026-10", "2026-10-30")).toMatchObject({
      progressCents: 0,
      remainingCents: 10000
    });
  });
  it("rejects unsafe combined totals instead of rounding them", () => {
    expect(() =>
      targetProgress(
        refill,
        {
          assignedCents: 1,
          activityCents: Number.MAX_SAFE_INTEGER,
          availableCents: Number.MAX_SAFE_INTEGER
        },
        "2026-10",
        "2026-10-30"
      )
    ).toThrow();
  });
});
