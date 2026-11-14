// tests/unit/external-module-finance-attention-model.test.ts
import { describe, expect, it } from "vitest";

import {
  addDays,
  attentionRows,
  billsDue,
  billsWindow,
  coverSource,
  monthEnd,
  spendingLines,
  stripFigures,
  type SpendingLine
} from "../../external-modules/finance/src/web/attention-model.js";
import type {
  BillsView,
  Occurrence
} from "../../external-modules/finance/src/web/screens/upcoming.js";

const line = (id: string, available: number, spent = 0, assigned = 0): SpendingLine => ({
  currency: "USD",
  id,
  name: id,
  assigned,
  spent,
  available,
  carried: null,
  archived: false,
  group: "Everyday"
});

const bill = (planId: string, dueDate: string, extra: Partial<Occurrence> = {}): Occurrence => ({
  planId,
  name: planId,
  accountId: "a1",
  categoryId: "c1",
  dueDate,
  expectedCents: 5000,
  state: "projected",
  actualCents: null,
  transactionId: null,
  ...extra
});

const view = (today: string, occurrences: Occurrence[]): BillsView =>
  ({
    today,
    isoCurrency: "USD",
    revision: 1,
    fingerprint: "f",
    occurrences,
    transactions: []
  }) as unknown as BillsView;

describe("finance attention model", () => {
  it("drops the Savings group and archived lines", () => {
    const lines = spendingLines([
      { name: "Savings", lines: [line("s", 100)] },
      { name: "Everyday", lines: [line("a", 100), { ...line("b", 100), archived: true }] }
    ]);
    expect(lines.map((l) => l.id)).toEqual(["a"]);
  });

  it("sums the strip figures", () => {
    const f = stripFigures([
      line("a", 300, 100, 400),
      line("b", -50, 150, 100),
      line("c", 200, 0, 200)
    ]);
    expect(f).toMatchObject({
      spentCents: 250,
      assignedCents: 700,
      leftCents: 500,
      leftCount: 2,
      overspentCents: -50,
      overspentCount: 1,
      worstOverspent: "b"
    });
  });

  it("computes month ends and windows", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
    expect(billsWindow("2026-11", "2026-11-28")).toEqual({ from: "2026-08-01", to: "2026-12-05" });
    expect(billsWindow("2027-01", "2027-01-10")).toEqual({ from: "2026-10-01", to: "2027-01-31" });
    expect(billsWindow("2026-10", "2026-11-28")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("counts open bills in the month", () => {
    const v = view("2026-11-10", [
      bill("p1", "2026-11-05"),
      bill("p2", "2026-11-15"),
      bill("p3", "2026-11-20", { state: "skipped" }),
      bill("p4", "2026-12-01")
    ]);
    expect(billsDue(v, "2026-11", "2026-11-10")).toEqual({
      cents: 10000,
      count: 2,
      pastDue: 1,
      next: "2026-11-15"
    });
  });

  it("covers from the category with the most left, or part of it", () => {
    const over = line("over", -100);
    expect(coverSource([over, line("a", 150), line("b", 900)], over, 100)?.id).toBe("b");
    expect(coverSource([over, line("a", 40), line("b", 60)], over, 100)).toMatchObject({
      id: "b",
      availableCents: 60
    });
    expect(coverSource([over], over, 100)).toBeNull();
  });

  it("orders rows: past due, overspent, due soon, predicted", () => {
    const rows = attentionRows({
      month: "2026-11",
      currentMonth: "2026-11",
      bills: view("2026-11-10", [
        bill("late", "2026-11-02"),
        bill("soon", "2026-11-14"),
        bill("far", "2026-11-25")
      ]),
      lines: [line("small", -10), line("big", -500), line("ok", 900)],
      predicted: {
        total: 2,
        rows: [
          { id: "t1", name: "Cafe", categoryName: "Dining", amountCents: 300 },
          { id: "t2", name: "Shop", categoryName: "Shopping", amountCents: 400 }
        ]
      }
    });
    expect(rows.map((r) => r.key)).toEqual([
      expect.stringContaining("late"),
      "over:big",
      "over:small",
      expect.stringContaining("soon"),
      "predicted"
    ]);
    const predicted = rows[4]!;
    expect(predicted.kind === "predicted" ? predicted.confirmable?.length : null).toBe(2);
  });

  it("lists unresolved bills from earlier months first, oldest first", () => {
    const rows = attentionRows({
      month: "2026-11",
      currentMonth: "2026-11",
      bills: view("2026-11-10", [
        bill("thisMonth", "2026-11-02"),
        bill("october", "2026-10-15"),
        bill("september", "2026-09-28"),
        bill("paid", "2026-10-05", { state: "posted" })
      ]),
      lines: [line("big", -500)],
      predicted: null
    });
    expect(rows.map((r) => r.key)).toEqual([
      expect.stringContaining("september"),
      expect.stringContaining("october"),
      expect.stringContaining("thisMonth"),
      "over:big"
    ]);
    expect(rows.slice(0, 3).every((r) => r.kind === "bill" && r.pastDue)).toBe(true);
  });

  it("offers no bulk confirm when the list is shorter than the count", () => {
    const rows = attentionRows({
      month: "2026-11",
      currentMonth: "2026-11",
      bills: null,
      lines: [],
      predicted: {
        total: 5,
        rows: [{ id: "t1", name: "Cafe", categoryName: null, amountCents: 300 }]
      }
    });
    const first = rows[0]!;
    expect(first.kind === "predicted" ? first.confirmable : "wrong").toBeNull();
  });

  it("offers no bulk confirm when a transaction has no guessed category", () => {
    const rows = attentionRows({
      month: "2026-11",
      currentMonth: "2026-11",
      bills: null,
      lines: [],
      predicted: {
        total: 2,
        rows: [
          { id: "t1", name: "Cafe", categoryName: "Dining", amountCents: 300 },
          { id: "t2", name: "Payout", categoryName: null, amountCents: 400 }
        ]
      }
    });
    const first = rows[0]!;
    expect(first.kind === "predicted" ? first.confirmable : "wrong").toBeNull();
  });

  it("returns nothing for a past month", () => {
    expect(
      attentionRows({
        month: "2026-10",
        currentMonth: "2026-11",
        bills: null,
        lines: [line("x", -5)],
        predicted: null
      })
    ).toEqual([]);
  });
});
