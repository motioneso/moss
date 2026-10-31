import { describe, expect, it, vi } from "vitest";
import {
  projectBillOccurrences,
  type BillAdjustment
} from "../../external-modules/finance/src/domain/bill-adjustments.js";
import type { BillPlan } from "../../external-modules/finance/src/domain/bills.js";
import { billAdjustHandler } from "../../external-modules/finance/src/worker/handlers/bill-adjustments.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const plan: BillPlan = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Synthetic monthly bill",
  accountId: "synthetic",
  categoryId: "groceries",
  isoCurrency: "USD",
  amountCents: 10000,
  anchorDate: "2026-01-31",
  cadence: "monthly"
};
const change = (dueDate: string, plannedDate: string, amountCents = 12345): BillAdjustment => ({
  planId: plan.id,
  dueDate,
  plannedDate,
  amountCents
});
describe("one-off bill projection dates and cents", () => {
  it("moves across months exactly once and preserves the original anchor and following cadence", () => {
    const original = structuredClone(plan),
      changes = [change("2026-01-31", "2026-02-03")];
    expect(projectBillOccurrences([plan], changes, "2026-01-01", "2026-01-31")).toEqual([]);
    expect(
      projectBillOccurrences([plan], changes, "2026-02-01", "2026-02-28").map((r) => [
        r.dueDate,
        r.plannedDate,
        r.expectedCents,
        r.adjusted
      ])
    ).toEqual([
      ["2026-01-31", "2026-02-03", 12345, true],
      ["2026-02-28", "2026-02-28", 10000, false]
    ]);
    expect(projectBillOccurrences([plan], changes, "2026-03-01", "2026-03-31")[0]).toMatchObject({
      dueDate: "2026-03-31",
      plannedDate: "2026-03-31",
      expectedCents: 10000
    });
    expect(plan).toEqual(original);
  });
  it("supports a move into an earlier year without changing the schedule identity", () => {
    expect(
      projectBillOccurrences(
        [plan],
        [change("2026-01-31", "2025-12-31", 1)],
        "2025-12-01",
        "2025-12-31"
      )[0]
    ).toMatchObject({ dueDate: "2026-01-31", plannedDate: "2025-12-31", expectedCents: 1 });
  });
  it("preserves leap and month-end anchors", () => {
    const monthly = { ...plan, anchorDate: "2024-01-31" };
    expect(
      projectBillOccurrences(
        [monthly],
        [change("2024-02-29", "2024-03-01")],
        "2024-03-01",
        "2024-03-31"
      ).map((r) => r.plannedDate)
    ).toEqual(["2024-03-01", "2024-03-31"]);
    const annual = { ...plan, anchorDate: "2024-02-29", cadence: "yearly" as const };
    expect(
      projectBillOccurrences(
        [annual],
        [change("2025-02-28", "2025-03-02")],
        "2025-03-01",
        "2025-03-31"
      )[0]?.plannedDate
    ).toBe("2025-03-02");
    expect(projectBillOccurrences([annual], [], "2026-02-01", "2026-02-28")[0]?.dueDate).toBe(
      "2026-02-28"
    );
  });
  it("keeps separate occurrences when more than one moves to the same day", () => {
    const rows = projectBillOccurrences(
      [plan],
      [change("2026-01-31", "2026-03-15"), change("2026-02-28", "2026-03-15")],
      "2026-03-01",
      "2026-03-31"
    );
    expect(rows.map((r) => r.dueDate)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(rows).toHaveLength(3);
  });
  it.each([0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid stored amounts (%s)",
    (amount) => {
      expect(() =>
        projectBillOccurrences(
          [plan],
          [change("2026-01-31", "2026-02-01", amount)],
          "2026-02-01",
          "2026-02-28"
        )
      ).toThrow();
    }
  );
  it("refuses malformed, duplicate, foreign and non-scheduled adjustments rather than silently omitting them", () => {
    for (const changes of [
      [change("2026-01-30", "2026-02-01")],
      [change("2026-01-31", "2026-02-30")],
      [{ ...change("2026-01-31", "2026-02-01"), planId: "other" }],
      [change("2026-01-31", "2026-02-01"), change("2026-01-31", "2026-02-02")]
    ])
      expect(() => projectBillOccurrences([plan], changes, "2026-02-01", "2026-02-28")).toThrow();
  });
  it("refuses a projection above its count or date-window bounds without truncation", () => {
    expect(() => projectBillOccurrences([plan], [], "2026-01-01", "2027-01-03")).toThrow();
    expect(() =>
      projectBillOccurrences(
        Array.from({ length: 501 }, (_, i) => ({
          ...plan,
          id: String(i),
          cadence: "once" as const
        })),
        [],
        "2026-01-01",
        "2026-01-31"
      )
    ).toThrow("500 occurrences");
  });
  it("validates malformed native write values before opening storage", async () => {
    const store = vi.fn();
    const run = billAdjustHandler({ store } as unknown as WorkerPorts);
    const valid = {
      planId: plan.id,
      dueDate: "2026-01-31",
      plannedDate: "2026-02-01",
      amountCents: 1,
      expectedRevision: 1,
      expectedFingerprint: "a".repeat(32)
    };
    for (const invalid of [
      { plannedDate: "2026-02-30" },
      { dueDate: "invalid" },
      { planId: "invalid" },
      { amountCents: 0 },
      { amountCents: 1.1 },
      { amountCents: 100000001 }
    ])
      await expect(run({ ...valid, ...invalid })).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
  });
});
