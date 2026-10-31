import { targetFundHandler } from "../../external-modules/finance/src/worker/handlers/target-funding.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { describe, expect, it, vi } from "vitest";
import {
  targetFundingLines,
  hasTargetFundingOverspending,
  selectTargetFunding
} from "../../external-modules/finance/src/domain/target-funding.js";
import {
  targetProgress,
  type CategoryTarget
} from "../../external-modules/finance/src/domain/targets.js";
const categories = [
  { id: "monthly", name: "Monthly" },
  { id: "dated", name: "Dated savings" }
];
const state = {
  monthly: { assignedCents: 1000, activityCents: 800, availableCents: 200 },
  dated: { assignedCents: 500, activityCents: 0, availableCents: 10000 }
};
const monthly: CategoryTarget = {
  categoryId: "monthly",
  effectiveMonth: "2026-10",
  kind: "monthly",
  amountCents: 12345,
  dueDate: null
};
const dated: CategoryTarget = {
  categoryId: "dated",
  effectiveMonth: "2026-10",
  kind: "balance",
  amountCents: 60000,
  dueDate: "2026-12-31"
};
const progress = () =>
  [monthly, dated].map((t) =>
    targetProgress(t, state[t.categoryId as keyof typeof state], "2026-10", "2026-10-30")
  );
const lines = () => targetFundingLines(progress(), state, categories, []);
describe("explicit selected target funding", () => {
  it("adds monthly and dated suggestions to existing totals without treating available money as assignments", () => {
    expect(lines()).toMatchObject([
      {
        categoryId: "monthly",
        previousCents: 1000,
        amountCents: 11345,
        newAssignedCents: 12345,
        unavailableReason: null
      },
      {
        categoryId: "dated",
        previousCents: 500,
        amountCents: 16667,
        newAssignedCents: 17167,
        unavailableReason: null
      }
    ]);
    expect(selectTargetFunding(lines(), ["monthly", "dated"], [11345, 16667], 30000)).toMatchObject(
      {
        totalCents: 28012,
        readyAfterCents: 1988,
        assignments: [
          { categoryId: "monthly", amountCents: 12345, previousCents: 1000 },
          { categoryId: "dated", amountCents: 17167, previousCents: 500 }
        ]
      }
    );
  });
  it("does not clamp insufficient funding or quietly choose a partial winner", () => {
    expect(() => selectTargetFunding(lines(), ["monthly", "dated"], [11345, 16667], 28011)).toThrow(
      /ready/i
    );
    expect(() => selectTargetFunding(lines(), ["monthly"], [11345], null)).toThrow(/unavailable/i);
    expect(() => selectTargetFunding(lines(), ["monthly"], [11345], -1)).toThrow(/ready/i);
  });
  it("requires unique eligible IDs and the exact captured suggestions", () => {
    for (const [ids, cents] of [
      [[], []],
      [
        ["monthly", "monthly"],
        [11345, 11345]
      ],
      [["unknown"], [1]],
      [["monthly"], [11344]],
      [["monthly"], []],
      [Array.from({ length: 21 }, (_, i) => String(i)), Array(21).fill(1)]
    ] as [string[], number[]][]) {
      expect(() => selectTargetFunding(lines(), ids, cents, 100000)).toThrow();
    }
  });
  it("keeps reached, archived and pooled targets visible with a reason and refuses selection", () => {
    const p = progress();
    const rows = targetFundingLines(
      [{ ...p[0]!, suggestedCents: 0, status: "reached" }, p[1]!],
      state,
      [{ ...categories[0]!, archived: true }, categories[1]!],
      ["dated"]
    );
    expect(rows.map((r) => r.unavailableReason)).toEqual(["archived", "pooled"]);
    const reached = targetFundingLines(
      [{ ...p[0]!, suggestedCents: 0, status: "reached" }],
      state,
      categories,
      []
    );
    expect(reached[0]?.unavailableReason).toBe("reached");
    expect(() => selectTargetFunding(rows, ["dated"], [16667], 100000)).toThrow();
  });
  it("discloses assignment bounds instead of producing an invalid write", () => {
    const rows = targetFundingLines(
      [{ ...progress()[0]!, suggestedCents: 1 }],
      { monthly: { assignedCents: 100000000, activityCents: 0, availableCents: 0 } },
      categories,
      []
    );
    expect(rows[0]).toMatchObject({
      unavailableReason: "assignment_limit",
      newAssignedCents: null
    });
    expect(() => selectTargetFunding(rows, ["monthly"], [1], 100000000)).toThrow();
  });
  it("preserves a negative existing assignment while adding its exact shortfall", () => {
    const negative = { monthly: { assignedCents: -50, activityCents: 0, availableCents: 0 } };
    const t = targetProgress(monthly, negative.monthly, "2026-10", "2026-10-30");
    const rows = targetFundingLines([t], negative, categories, []);
    expect(selectTargetFunding(rows, ["monthly"], [12395], 12395).assignments).toEqual([
      { categoryId: "monthly", previousCents: -50, amountCents: 12345 }
    ]);
  });
});

describe("target funding native input boundaries", () => {
  it("uses Moss local month at a timezone boundary before opening storage", async () => {
    const store = vi.fn();
    const run = targetFundHandler({
      store,
      now: () => new Date("2026-10-31T23:30:00Z"),
      localTimezone: "Pacific/Auckland"
    } as unknown as WorkerPorts);
    await expect(run({ month: "2026-10" })).rejects.toThrow(/current month/i);
    expect(store).not.toHaveBeenCalled();
  });
  it("rejects malformed captured selections before opening storage", async () => {
    const store = vi.fn();
    const run = targetFundHandler({
      store,
      now: () => new Date("2026-10-30T12:00:00Z"),
      localTimezone: "UTC"
    } as unknown as WorkerPorts);
    for (const input of [
      { categoryIds: [], expectedAmountsCents: [] },
      { categoryIds: ["a", "a"], expectedAmountsCents: [1, 1] },
      { categoryIds: ["a"], expectedAmountsCents: [0] },
      { categoryIds: ["a"], expectedAmountsCents: [1.001] },
      { categoryIds: ["a"], expectedAmountsCents: [100000001] }
    ])
      await expect(run({ month: "2026-10", ...input })).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
  });
});

describe("target funding overspending priority", () => {
  it("requires negative category repair without treating income or transfer rows as envelopes", () => {
    const row = { assignedCents: 0, activityCents: 1, availableCents: -1 };
    expect(hasTargetFundingOverspending({ dining: row })).toBe(true);
    expect(hasTargetFundingOverspending({ income: row, transfers: row })).toBe(false);
    expect(hasTargetFundingOverspending({ dining: { ...row, availableCents: 0 } })).toBe(false);
  });
});
