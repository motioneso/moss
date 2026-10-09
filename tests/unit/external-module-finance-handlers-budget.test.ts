// tests/unit/external-module-finance-handlers-budget.test.ts
import { describe, expect, it } from "vitest";

import { kvStore, NS } from "../../external-modules/finance/src/domain/index.js";
import type {
  ActivityInput,
  FinanceKv,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import {
  budgetApplyHandler,
  budgetAssignHandler,
  budgetStatusHandler
} from "../../external-modules/finance/src/worker/handlers/budget.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// FIN-03 (#1148) Task 3+5, cut over to FinanceStore + state-cache retirement
// by FIN-06c (#1166) Task 10: the budget handler contracts (spec delta
// §"Worker delta"). Pinned here: `ledger:{month}` is the source of truth and
// assign SETS a total (never increments, so the budget-apply queue stays
// replay-safe at retryLimit 1); status always derives fresh from
// loadDerivationInput — SQL month reads are one indexed query, so the old
// `state:{month}` read-amplification cache is gone (F6-D1). The queue twin
// consumes the HOST job envelope (ids in input.params — the a6023cb7
// regression), not flat ids.

const NOW = new Date("2026-07-18T12:00:00Z");

function fakeKv(): FinanceKv {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const ns = (namespace: string) => {
    let bucket = store.get(namespace);
    if (!bucket) {
      bucket = new Map();
      store.set(namespace, bucket);
    }
    return bucket;
  };
  return {
    get: async (namespace, key) => structuredClone(ns(namespace).get(key) ?? null),
    set: async (namespace, key, value) => {
      ns(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => ns(namespace).delete(key),
    list: async (namespace) => [...ns(namespace).keys()]
  };
}

// Budget handlers are pure KV reads/writes — same isolation contract as the
// feed handlers: touching Plaid creds, tokens, or instance settings throws.
function fakePorts(kv: FinanceKv, activity: ActivityInput[] = []): WorkerPorts {
  return {
    kv,
    // FIN-04 (#1149): mirror writes are share/sync-handler territory only.
    mirror: {
      get: async () => {
        throw new Error("budget handlers must not read the household mirror");
      },
      set: async () => {
        throw new Error("budget handlers must not write the household mirror");
      },
      delete: async () => {
        throw new Error("budget handlers must not delete from the household mirror");
      },
      list: async () => {
        throw new Error("budget handlers must not list the household mirror");
      }
    },
    ai: null,
    db: null,
    plaid: null,
    tokens: {
      read: async () => {
        throw new Error("budget handlers must not read tokens");
      },
      write: async () => {
        throw new Error("budget handlers must not write tokens");
      }
    },
    creds: {
      get: async () => {
        throw new Error("budget handlers must not read creds");
      }
    },
    settings: {
      getEnvironment: async () => {
        throw new Error("budget handlers must not read settings");
      }
    },
    isAdmin: false,
    now: () => NOW,
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => ({
      ...kvStore(kv),
      appendActivity: async (entry) => {
        activity.push(entry);
      }
    })
  };
}

let txnSeq = 0;
function txRecord(over: Partial<TransactionRecord> & { amountCents: number }): TransactionRecord {
  txnSeq += 1;
  return {
    id: `tx-${txnSeq}`,
    accountId: "acc-1",
    date: "2026-07-10",
    isoCurrency: "USD",
    name: "ACME",
    merchant: null,
    plaidCategory: null,
    categoryId: null,
    pending: false,
    pendingTransactionId: null,
    categorizedBy: null,
    ...over
  };
}

async function seedJuly(kv: FinanceKv): Promise<void> {
  await kv.set(NS.transactions, "acc-1:2026-07", {
    transactions: [
      txRecord({ categoryId: "income", amountCents: -200_000 }),
      txRecord({ categoryId: "groceries", amountCents: 12_345 })
    ]
  });
  await kv.set(NS.budgets, "ledger:2026-07", { assignments: { groceries: 50_000 } });
}

describe("finance budget.status (#1148)", () => {
  it("derives the month from ledger + chunks", async () => {
    const kv = fakeKv();
    await seedJuly(kv);

    const result = await budgetStatusHandler(fakePorts(kv))({ month: "2026-07" });

    expect(result.month).toBe("2026-07");
    expect(result.state).toEqual({
      computedAt: NOW.toISOString(),
      tbbCents: 150_000,
      categories: {
        income: { assignedCents: 0, activityCents: -200_000, availableCents: 200_000 },
        groceries: { assignedCents: 50_000, activityCents: 12_345, availableCents: 37_655 }
      }
    });
    // The taxonomy rides along so the web screen renders groups in one call.
    expect((result.categories as Array<{ id: string }>).some((c) => c.id === "groceries")).toBe(
      true
    );
  });

  it("reports ready to assign from account balances, card debt and each envelope (#3173)", async () => {
    const kv = fakeKv();
    await seedJuly(kv);
    await kv.set(NS.connections, "item:i1", {
      itemId: "i1",
      institutionId: "ins_1",
      connectedAt: NOW.toISOString(),
      status: "reauth-required"
    });
    const account = (accountId: string, type: string, balanceCents: number) => ({
      accountId,
      itemId: "i1",
      name: accountId,
      officialName: null,
      type,
      subtype: null,
      mask: null,
      balanceCents,
      isoCurrency: "USD",
      updatedAt: "2026-07-17T00:00:00Z"
    });
    await kv.set(NS.accounts, "acc-1", account("acc-1", "depository", 187_655));
    await kv.set(NS.accounts, "acc-2", account("acc-2", "credit", 10_000));

    const result = await budgetStatusHandler(fakePorts(kv))({ month: "2026-07" });

    // 1876.55 in checking - 100.00 owed on the card - 376.55 left in groceries.
    expect(result.readyToAssignCents).toBe(140_000);
    expect(result.hasBank).toBe(true);
    expect(result.accounts).toEqual([
      expect.objectContaining({ accountId: "acc-1", balanceCents: 187_655, stale: true }),
      expect.objectContaining({ accountId: "acc-2", balanceCents: -10_000, stale: true })
    ]);
  });

  it("rolls carry and TBB into a later month with no data of its own", async () => {
    const kv = fakeKv();
    await seedJuly(kv);

    const result = await budgetStatusHandler(fakePorts(kv))({ month: "2026-08" });
    const state = result.state as {
      tbbCents: number;
      categories: Record<string, { availableCents: number }>;
    };
    expect(state.tbbCents).toBe(150_000);
    expect(state.categories.groceries!.availableCents).toBe(37_655);
  });

  it("rejects a malformed month", async () => {
    const kv = fakeKv();
    await expect(budgetStatusHandler(fakePorts(kv))({ month: "July 2026" })).rejects.toThrow(
      "month must be YYYY-MM"
    );
  });

  it("excludes auto-paired transfers from derivation (FIN-05 pre-filter)", async () => {
    const kv = fakeKv();
    await kv.set(NS.transactions, "acc-1:2026-07", {
      transactions: [
        txRecord({ categoryId: "income", amountCents: -200_000 }),
        // transfer-in miscategorized as income: its pair (below, categorized
        // transfers on ANOTHER account) must pull it out of derivation, so
        // TBB stays 2000.00 instead of inflating by 500.00 (spec delta
        // §"Transfer auto-pairing", the deliberate-TBB-shift consequence).
        txRecord({ id: "pair-in", categoryId: "income", amountCents: -50_000, date: "2026-07-11" })
      ]
    });
    await kv.set(NS.transactions, "acc-2:2026-07", {
      transactions: [
        txRecord({
          id: "pair-out",
          accountId: "acc-2",
          categoryId: "transfers",
          amountCents: 50_000,
          date: "2026-07-10"
        })
      ]
    });

    const result = await budgetStatusHandler(fakePorts(kv))({ month: "2026-07" });
    expect((result.state as { tbbCents: number }).tbbCents).toBe(200_000);
  });
});

describe("finance budget.assign — tool path (#1148)", () => {
  it("sets the assignment total, preserving other categories in the ledger", async () => {
    const kv = fakeKv();
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { dining: 5_000 } });

    const result = await budgetAssignHandler(fakePorts(kv))({
      month: "2026-07",
      categoryId: "groceries",
      amountCents: 50_000
    });

    expect(result).toEqual({
      status: "ok",
      month: "2026-07",
      categoryId: "groceries",
      amountCents: 50_000
    });
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { dining: 5_000, groceries: 50_000 }
    });
  });

  it("replaces on re-assign — set semantics, never increment", async () => {
    const kv = fakeKv();
    const assign = budgetAssignHandler(fakePorts(kv));
    await assign({ month: "2026-07", categoryId: "groceries", amountCents: 50_000 });
    await assign({ month: "2026-07", categoryId: "groceries", amountCents: 20_000 });

    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { groceries: 20_000 }
    });
  });

  it("rejects an unknown category, a fractional amount, and out-of-range amounts", async () => {
    const kv = fakeKv();
    const assign = budgetAssignHandler(fakePorts(kv));
    await expect(
      assign({ month: "2026-07", categoryId: "yachts", amountCents: 1 })
    ).rejects.toThrow("not a live category");
    await expect(
      assign({ month: "2026-07", categoryId: "groceries", amountCents: 10.5 })
    ).rejects.toThrow();
    await expect(
      assign({ month: "2026-07", categoryId: "groceries", amountCents: 100_000_001 })
    ).rejects.toThrow();
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toBeNull();
  });
});

describe("finance budget-apply — queue path (#1148)", () => {
  it("reads the host job envelope: params carry the command, never the top level", async () => {
    const kv = fakeKv();
    const apply = budgetApplyHandler(fakePorts(kv));

    const result = await apply({
      actorUserId: "11111111-1111-4111-8111-111111111111",
      jobKind: "finance.budget-apply",
      idempotencyKey: "idem-1",
      params: { month: "2026-07", categoryId: "groceries", amountCents: 50_000 }
    });

    expect(result).toMatchObject({ status: "ok", categoryId: "groceries" });
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { groceries: 50_000 }
    });
  });

  it("rejects flat ids (the a6023cb7 regression) and a foreign jobKind", async () => {
    const kv = fakeKv();
    const apply = budgetApplyHandler(fakePorts(kv));
    await expect(
      apply({
        jobKind: "finance.budget-apply",
        month: "2026-07",
        categoryId: "groceries",
        amountCents: 1
      })
    ).rejects.toThrow("params must be an object");
    await expect(
      apply({
        jobKind: "finance.categorize-apply",
        params: { month: "2026-07", categoryId: "groceries", amountCents: 1 }
      })
    ).rejects.toThrow("jobKind is not supported");
  });
});

describe("finance budget activity rows (#3174)", () => {
  it("queue path logs a user row holding ids and cents only, with undo to the old total", async () => {
    const kv = fakeKv();
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { groceries: 20_000 } });
    const activity: ActivityInput[] = [];

    await budgetApplyHandler(fakePorts(kv, activity))({
      jobKind: "finance.budget-apply",
      params: { month: "2026-07", categoryId: "groceries", amountCents: 50_000 }
    });

    expect(activity).toEqual([
      {
        actor: "user",
        kind: "budget.assign",
        params: {
          month: "2026-07",
          categoryId: "groceries",
          amountCents: 50_000,
          previousCents: 20_000
        },
        undo: { month: "2026-07", categoryId: "groceries", amountCents: 20_000 }
      }
    ]);
  });

  it("tool path logs the row as moss", async () => {
    const kv = fakeKv();
    const activity: ActivityInput[] = [];
    await budgetAssignHandler(fakePorts(kv, activity))({
      month: "2026-07",
      categoryId: "groceries",
      amountCents: 7_500
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actor: "moss",
      params: { amountCents: 7_500, previousCents: 0 }
    });
  });

  it("logs nothing when the amount did not change", async () => {
    const kv = fakeKv();
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { groceries: 20_000 } });
    const activity: ActivityInput[] = [];
    await budgetAssignHandler(fakePorts(kv, activity))({
      month: "2026-07",
      categoryId: "groceries",
      amountCents: 20_000
    });
    expect(activity).toEqual([]);
  });

  it("logs nothing when the category is rejected", async () => {
    const kv = fakeKv();
    const activity: ActivityInput[] = [];
    await expect(
      budgetAssignHandler(fakePorts(kv, activity))({
        month: "2026-07",
        categoryId: "no-such-category",
        amountCents: 100
      })
    ).rejects.toThrow();
    expect(activity).toEqual([]);
  });
});
