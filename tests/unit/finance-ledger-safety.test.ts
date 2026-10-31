import { describe, expect, it } from "vitest";
import { monthKey } from "../../external-modules/finance/src/domain/keys.js";
import { toRecord, type PlaidTx } from "../../external-modules/finance/src/domain/reduce.js";
import { pairTransfers } from "../../external-modules/finance/src/domain/transfers.js";
import { readInt } from "../../external-modules/finance/src/worker/validate.js";
import { budgetApplyHandler } from "../../external-modules/finance/src/worker/handlers/budget.js";
import { kvStore, NS, type FinanceKv } from "../../external-modules/finance/src/domain/index.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

const raw: PlaidTx = {
  transaction_id: "synthetic-a",
  account_id: "synthetic-checking",
  date: "2026-10-01",
  amount: 1.005,
  iso_currency_code: "USD",
  name: "Synthetic purchase",
  merchant_name: null,
  personal_finance_category: null,
  pending: false,
  pending_transaction_id: null
};

describe("ledger boundaries", () => {
  it("rounds decimal provider amounts symmetrically without binary float drift", () => {
    expect(toRecord(raw).amountCents).toBe(101);
    expect(toRecord({ ...raw, amount: -1.005 }).amountCents).toBe(-101);
    expect(toRecord({ ...raw, amount: 4.56 }).amountCents).toBe(456);
  });
  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects unrepresentable provider money %s",
    (amount) => {
      expect(() => toRecord({ ...raw, amount })).toThrow();
    }
  );
  it("rejects unsafe integer tool inputs", () => {
    expect(() => readInt({ amountCents: Number.MAX_SAFE_INTEGER + 1 }, "amountCents")).toThrow();
  });
  it.each(["2026-00-01", "2026-13-01", "2026-02-29", "2026-04-31", "2026-01-00"])(
    "rejects impossible provider date %s",
    (date) => {
      expect(() => monthKey("synthetic", date)).toThrow();
    }
  );
  it("accepts leap day and preserves the calendar month", () => {
    expect(monthKey("synthetic", "2028-02-29")).toBe("synthetic:2028-02");
  });
  it("does not infer a transfer between equal numbers in different currencies", () => {
    const out = { ...toRecord({ ...raw, amount: 50 }), categoryId: "transfers" };
    const incoming = toRecord({
      ...raw,
      transaction_id: "synthetic-b",
      account_id: "savings",
      amount: -50,
      iso_currency_code: "EUR"
    });
    expect(pairTransfers([out, incoming])).toEqual([]);
  });
});

describe("budget batch validation", () => {
  function fixture() {
    const data = new Map<string, Record<string, unknown>>();
    const kv: FinanceKv = {
      get: async (ns, key) => structuredClone(data.get(`${ns}:${key}`) ?? null),
      set: async (ns, key, value) => {
        data.set(`${ns}:${key}`, structuredClone(value));
      },
      list: async () => [],
      delete: async () => false
    };
    const store = kvStore(kv);
    const ports = { kv, store: async () => store } as WorkerPorts;
    return { kv, handler: budgetApplyHandler(ports) };
  }
  it("a bad last category changes neither the first category nor its activity", async () => {
    const { kv, handler } = fixture();
    await expect(
      handler({
        jobKind: "finance.budget-apply",
        params: {
          month: "2026-10",
          categoryIds: ["groceries", "missing"],
          amountsCents: [2000, 1000]
        }
      })
    ).rejects.toThrow();
    expect(await kv.get(NS.budgets, "ledger:2026-10")).toBeNull();
  });
  it("rejects repeated categories and impossible months", async () => {
    const { kv, handler } = fixture();
    for (const params of [
      { month: "2026-10", categoryIds: ["groceries", "groceries"], amountsCents: [1, 2] },
      { month: "2026-13", categoryIds: ["groceries"], amountsCents: [1] }
    ])
      await expect(handler({ jobKind: "finance.budget-apply", params })).rejects.toThrow();
    expect(await kv.get(NS.budgets, "ledger:2026-13")).toBeNull();
  });
});
