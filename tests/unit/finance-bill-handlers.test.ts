import { describe, expect, it, vi } from "vitest";
import {
  billCreateHandler,
  billDecideHandler,
  billsReadHandler
} from "../../external-modules/finance/src/worker/handlers/bills.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { BillPlan } from "../../external-modules/finance/src/domain/bills.js";
const tokens = { expectedRevision: 1, expectedFingerprint: "a".repeat(32) };
const plan: BillPlan = {
  id: "94bfda66-d527-4b21-8f42-11dfe10408db",
  name: "Synthetic bill",
  accountId: "cash",
  categoryId: "utilities",
  isoCurrency: "USD",
  amountCents: 100,
  anchorDate: "2026-01-31",
  cadence: "monthly"
};
function fixture() {
  const bills = {
    plans: async () => [plan],
    decisions: async () => [
      {
        planId: plan.id,
        dueDate: "2026-02-28",
        state: "matched",
        transactionId: "earlier-month",
        actualCents: 103,
        matchedValid: true
      }
    ],
    decide: vi.fn(async () => true),
    create: vi.fn(async () => true)
  };
  const policy = {
    get: async () => ({
      revision: 1,
      fingerprint: "a".repeat(32),
      isoCurrency: "USD",
      taxonomyReady: true
    }),
    categories: async () => []
  };
  const store = {
    bills,
    budgetPolicy: policy,
    listAccounts: async () => [],
    listTransactionMonths: async () => [],
    listMonthTransactions: async () => []
  };
  const ports = {
    store: async () => store,
    now: () => new Date("2026-02-28T00:00:00Z"),
    timezone: "UTC"
  } as unknown as WorkerPorts;
  return { ports, bills };
}
describe("reviewed bill handler validation", () => {
  it("rejects a non-occurrence rather than recording an arbitrary due date", async () => {
    const f = fixture();
    await expect(
      billDecideHandler(f.ports)({
        ...tokens,
        planId: plan.id,
        dueDate: "2026-02-27",
        state: "skipped"
      })
    ).rejects.toThrow();
    expect(f.bills.decide).not.toHaveBeenCalled();
  });
  it("accepts a clamped occurrence and requires a transaction only for matching", async () => {
    const f = fixture();
    await expect(
      billDecideHandler(f.ports)({
        ...tokens,
        planId: plan.id,
        dueDate: "2026-02-28",
        state: "matched"
      })
    ).rejects.toThrow();
    expect(
      await billDecideHandler(f.ports)({
        ...tokens,
        planId: plan.id,
        dueDate: "2026-02-28",
        state: "skipped"
      })
    ).toMatchObject({ status: "ok" });
  });
  it("rejects stale and malformed monetary reviews before writing", async () => {
    const f = fixture();
    const input = {
      ...tokens,
      id: plan.id,
      name: plan.name,
      accountId: "cash",
      categoryId: "utilities",
      amountCents: 100,
      anchorDate: "2026-02-28",
      cadence: "monthly"
    };
    await expect(billCreateHandler(f.ports)({ ...input, expectedRevision: 0 })).rejects.toThrow();
    await expect(billCreateHandler(f.ports)({ ...input, amountCents: 1.5 })).rejects.toThrow();
    await expect(
      billCreateHandler(f.ports)({ ...input, anchorDate: "2026-02-30" })
    ).rejects.toThrow();
    expect(f.bills.create).not.toHaveBeenCalled();
  });
  it("rejects an excessive projection even when there are no bills", async () => {
    const f = fixture();
    await expect(
      billsReadHandler(f.ports)({ from: "2026-01-01", to: "2028-01-01" })
    ).rejects.toThrow();
  });
});
