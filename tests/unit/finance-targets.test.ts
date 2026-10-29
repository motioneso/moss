import { describe, expect, it } from "vitest";
import {
  targetProgress,
  type CategoryTarget
} from "../../external-modules/finance/src/domain/targets.js";
const goal: CategoryTarget = {
  categoryId: "savings",
  effectiveMonth: "2026-10",
  kind: "balance",
  amountCents: 100,
  dueDate: "2026-12-31"
};
describe("category target guidance", () => {
  it("distributes the cent remainder with a ceiling over inclusive months", () => {
    expect(targetProgress(goal, undefined, "2026-10", "2026-10-29")).toMatchObject({
      remainingCents: 100,
      suggestedCents: 34,
      status: "in-progress"
    });
  });
  it("counts carry for a balance target and covers existing overspending", () => {
    expect(
      targetProgress(
        goal,
        { assignedCents: 0, activityCents: 0, availableCents: -2 },
        "2026-10",
        "2026-10-29"
      )
    ).toMatchObject({ progressCents: 0, remainingCents: 102, suggestedCents: 34 });
  });
  it("counts net assignments only for monthly targets", () => {
    expect(
      targetProgress(
        { ...goal, kind: "monthly", dueDate: null },
        { assignedCents: 20, activityCents: 150, availableCents: 300 },
        "2026-10",
        "2026-10-29"
      )
    ).toMatchObject({ progressCents: 20, remainingCents: 80, suggestedCents: 80 });
  });
  it("handles a year boundary, due-day boundary and reached goal", () => {
    expect(
      targetProgress({ ...goal, dueDate: "2027-01-31" }, undefined, "2026-12", "2026-12-31")
        .suggestedCents
    ).toBe(50);
    expect(targetProgress(goal, undefined, "2026-12", "2026-12-31").status).toBe("in-progress");
    expect(targetProgress(goal, undefined, "2027-01", "2027-01-01").status).toBe("overdue");
    expect(
      targetProgress(
        goal,
        { assignedCents: 0, activityCents: 0, availableCents: 100 },
        "2027-01",
        "2027-01-01"
      ).status
    ).toBe("reached");
  });
  it("rejects overflow instead of rounding remaining cents", () => {
    expect(() =>
      targetProgress(
        { ...goal, amountCents: Number.MAX_SAFE_INTEGER },
        { assignedCents: 0, activityCents: 0, availableCents: -1 },
        "2026-10",
        "2026-10-29"
      )
    ).toThrow();
  });
});
