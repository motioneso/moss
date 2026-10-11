// tests/unit/external-module-finance-chat-actions.test.ts
import { describe, expect, it } from "vitest";

import { kvStore, NS } from "../../external-modules/finance/src/domain/index.js";
import type { ActivityInput, FinanceKv } from "../../external-modules/finance/src/domain/index.js";
import {
  budgetAssignHandler,
  budgetMoveHandler
} from "../../external-modules/finance/src/worker/handlers/budget.js";
import {
  categoryArchiveHandler,
  categoryUpsertHandler,
  ruleSetHandler
} from "../../external-modules/finance/src/worker/handlers/organize.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// #3185: chat money and category actions. Each tool validates at the boundary, returns
// before and after, and logs an activity row with ids only.

const NOW = new Date("2026-07-18T12:00:00Z");

function fakeKv(): FinanceKv {
  const buckets = new Map<string, Map<string, Record<string, unknown>>>();
  const ns = (name: string) => {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = new Map();
      buckets.set(name, bucket);
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

function fakePorts(kv: FinanceKv, activity: ActivityInput[]): WorkerPorts {
  const refuse = (what: string) => async () => {
    throw new Error(`chat action handlers must not touch ${what}`);
  };
  return {
    kv,
    mirror: {
      get: refuse("the mirror"),
      set: refuse("the mirror"),
      delete: refuse("the mirror"),
      list: refuse("the mirror")
    },
    ai: null,
    db: null,
    plaid: null,
    tokens: { read: refuse("tokens"), write: refuse("tokens") },
    creds: { get: refuse("creds") },
    settings: { getEnvironment: refuse("settings") },
    isAdmin: false,
    now: () => NOW,
    store: async () => ({
      ...kvStore(kv),
      appendActivity: async (entry: ActivityInput) => {
        activity.push(entry);
      }
    })
  } as unknown as WorkerPorts;
}

async function seedBank(kv: FinanceKv, balanceCents: number): Promise<void> {
  await kvStore(kv).putAccount({
    accountId: "acc-1",
    itemId: "item-1",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: null,
    balanceCents,
    isoCurrency: "USD",
    updatedAt: NOW.toISOString()
  });
}

describe("finance.budget.assign previousCents (#3185)", () => {
  it("rejects a previous total that differs from the stored one", async () => {
    const kv = fakeKv();
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { groceries: 50_000 } });
    const activity: ActivityInput[] = [];
    await expect(
      budgetAssignHandler(fakePorts(kv, activity))({
        month: "2026-07",
        categoryId: "groceries",
        amountCents: 51_000,
        previousCents: 0
      })
    ).rejects.toThrow("previousCents does not match");
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { groceries: 50_000 }
    });
    expect(activity).toEqual([]);
  });

  it("requires previousCents", async () => {
    const kv = fakeKv();
    await expect(
      budgetAssignHandler(fakePorts(kv, []))({
        month: "2026-07",
        categoryId: "groceries",
        amountCents: 100
      })
    ).rejects.toThrow("previousCents is required");
  });
});

describe("finance.budget.move (#3185)", () => {
  it("moves from ready to assign into a category and reports before and after", async () => {
    const kv = fakeKv();
    await seedBank(kv, 8_000);
    const activity: ActivityInput[] = [];
    const result = await budgetMoveHandler(fakePorts(kv, activity))({
      month: "2026-07",
      fromCategoryId: "ready_to_assign",
      toCategoryId: "groceries",
      amountCents: 5_000
    });
    expect(result).toMatchObject({
      status: "ok",
      before: { fromAssignedCents: null, toAssignedCents: 0 },
      after: { fromAssignedCents: null, toAssignedCents: 5_000 }
    });
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { groceries: 5_000 }
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actor: "moss",
      kind: "budget.move",
      params: {
        month: "2026-07",
        fromCategoryId: "ready_to_assign",
        toCategoryId: "groceries",
        amountCents: 5_000
      }
    });
  });

  it("refuses more than is ready to assign", async () => {
    const kv = fakeKv();
    await seedBank(kv, 8_000);
    const activity: ActivityInput[] = [];
    await expect(
      budgetMoveHandler(fakePorts(kv, activity))({
        month: "2026-07",
        fromCategoryId: "ready_to_assign",
        toCategoryId: "groceries",
        amountCents: 8_001
      })
    ).rejects.toThrow("more than is ready to assign");
    expect(activity).toEqual([]);
  });

  it("moves between two categories, both totals changing together", async () => {
    const kv = fakeKv();
    await seedBank(kv, 20_000);
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { dining: 20_000, travel: 1_000 } });
    const activity: ActivityInput[] = [];
    const result = await budgetMoveHandler(fakePorts(kv, activity))({
      month: "2026-07",
      fromCategoryId: "dining",
      toCategoryId: "travel",
      amountCents: 7_500
    });
    expect(result).toMatchObject({
      before: { fromAssignedCents: 20_000, toAssignedCents: 1_000 },
      after: { fromAssignedCents: 12_500, toAssignedCents: 8_500 }
    });
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { dining: 12_500, travel: 8_500 }
    });
    expect(activity[0]?.undo).toMatchObject({ fromPreviousCents: 20_000, toPreviousCents: 1_000 });
  });

  it("refuses more than the source category holds", async () => {
    const kv = fakeKv();
    await seedBank(kv, 20_000);
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { dining: 2_000 } });
    await expect(
      budgetMoveHandler(fakePorts(kv, []))({
        month: "2026-07",
        fromCategoryId: "dining",
        toCategoryId: "travel",
        amountCents: 2_001
      })
    ).rejects.toThrow("more than the source holds");
  });

  it("rejects unknown ids, the same id twice, a non-positive amount, and ready as destination", async () => {
    const kv = fakeKv();
    await seedBank(kv, 20_000);
    const move = budgetMoveHandler(fakePorts(kv, []));
    const base = { month: "2026-07", amountCents: 100 };
    await expect(
      move({ ...base, fromCategoryId: "ready_to_assign", toCategoryId: "yachts" })
    ).rejects.toThrow("not a live category");
    await expect(
      move({ ...base, fromCategoryId: "dining", toCategoryId: "dining" })
    ).rejects.toThrow("must differ");
    await expect(
      move({ ...base, fromCategoryId: "dining", toCategoryId: "ready_to_assign" })
    ).rejects.toThrow("must be a category");
    await expect(
      move({ month: "2026-07", fromCategoryId: "dining", toCategoryId: "travel", amountCents: 0 })
    ).rejects.toThrow("at least 1");
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toBeNull();
  });
});

describe("money moves are all-or-nothing (#3160 review)", () => {
  it("changes nothing when the single write fails", async () => {
    const kv = fakeKv();
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { dining: 20_000, travel: 1_000 } });
    const ports = fakePorts(kv, []);
    const base = await ports.store();
    let commits = 0;
    ports.store = async () => ({
      ...base,
      // Any partial write would show up as a direct total change before this throws.
      setAssignment: async () => {
        throw new Error("a move must not write totals one at a time");
      },
      appendActivity: async () => {
        throw new Error("a move must not log separately");
      },
      commitBudgetChange: async () => {
        commits += 1;
        throw new Error("database went away");
      }
    });
    await expect(
      budgetMoveHandler(ports)({
        month: "2026-07",
        fromCategoryId: "dining",
        toCategoryId: "travel",
        amountCents: 7_500
      })
    ).rejects.toThrow("database went away");
    expect(commits).toBe(1);
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toEqual({
      assignments: { dining: 20_000, travel: 1_000 }
    });
  });

  it("refuses to assign or move money into an archived category", async () => {
    const kv = fakeKv();
    await seedBank(kv, 50_000);
    const ports = fakePorts(kv, []);
    const created = (await categoryUpsertHandler(ports)({
      name: "Pets",
      groupName: "Everyday"
    })) as { categoryId: string };
    const pets = created.categoryId;
    await categoryArchiveHandler(ports)({ id: pets });
    await expect(
      budgetAssignHandler(ports)({
        month: "2026-07",
        categoryId: pets,
        amountCents: 1_000,
        previousCents: 0
      })
    ).rejects.toThrow();
    await expect(
      budgetMoveHandler(ports)({
        month: "2026-07",
        fromCategoryId: "ready_to_assign",
        toCategoryId: pets,
        amountCents: 1_000
      })
    ).rejects.toThrow();
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toBeNull();
  });
});

describe("finance.rule.set (#3185)", () => {
  it("stores a rule, reports before and after, and logs ids only", async () => {
    const kv = fakeKv();
    const activity: ActivityInput[] = [];
    const run = ruleSetHandler(fakePorts(kv, activity));
    const first = await run({ merchant: "Trader Joe's #123", categoryId: "groceries" });
    expect(first).toMatchObject({
      before: { categoryId: null },
      after: { categoryId: "groceries" }
    });
    const second = await run({ merchant: "trader joes", categoryId: "dining" });
    expect(second).toMatchObject({
      before: { categoryId: "groceries" },
      after: { categoryId: "dining" }
    });
    expect(activity).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toContain("Trader");
    expect(activity[1]).toMatchObject({
      actor: "moss",
      kind: "merchant-rule.set",
      params: { categoryId: "dining", previousCategoryId: "groceries" }
    });
  });

  it("rejects an unknown category and a merchant with no letters", async () => {
    const kv = fakeKv();
    const run = ruleSetHandler(fakePorts(kv, []));
    await expect(run({ merchant: "Costco", categoryId: "yachts" })).rejects.toThrow(
      "not a live category"
    );
    await expect(run({ merchant: "1234", categoryId: "groceries" })).rejects.toThrow("no letters");
    expect(await kv.list(NS.rules)).toEqual([]);
  });
});

describe("finance.category.upsert and archive (#3185)", () => {
  it("adds a category, then renames and regroups it", async () => {
    const kv = fakeKv();
    const activity: ActivityInput[] = [];
    const ports = fakePorts(kv, activity);
    const added = await categoryUpsertHandler(ports)({ name: "Car repairs", groupName: "Bills" });
    expect(added).toMatchObject({ categoryId: "car-repairs", before: null });
    const renamed = await categoryUpsertHandler(ports)({
      id: "car-repairs",
      name: "Car upkeep",
      groupName: "Everyday"
    });
    expect(renamed).toMatchObject({
      before: { name: "Car repairs", groupName: "Bills" },
      after: { name: "Car upkeep", groupName: "Everyday" }
    });
    expect(activity.map((row) => row.kind)).toEqual(["category.add", "category.edit"]);
    expect(JSON.stringify(activity)).not.toContain("Car");
  });

  it("rejects a duplicate live name, an unknown id, and a bad group", async () => {
    const kv = fakeKv();
    const ports = fakePorts(kv, []);
    await expect(
      categoryUpsertHandler(ports)({ name: "groceries", groupName: "Everyday" })
    ).rejects.toThrow("already has that name");
    await expect(
      categoryUpsertHandler(ports)({ id: "nope", name: "X", groupName: "Everyday" })
    ).rejects.toThrow("not a live category");
    await expect(categoryUpsertHandler(ports)({ name: "X", groupName: "Luxury" })).rejects.toThrow(
      "must be one of"
    );
  });

  it("archives an empty category and refuses one with money assigned this month", async () => {
    const kv = fakeKv();
    await kv.set(NS.budgets, "ledger:2026-07", { assignments: { travel: 100 } });
    const activity: ActivityInput[] = [];
    const ports = fakePorts(kv, activity);
    await expect(categoryArchiveHandler(ports)({ id: "travel" })).rejects.toThrow(
      "money assigned this month"
    );
    const done = await categoryArchiveHandler(ports)({ id: "fuel" });
    expect(done).toMatchObject({ before: { archived: false }, after: { archived: true } });
    expect(activity.map((row) => row.kind)).toEqual(["category.archive"]);
    await expect(categoryArchiveHandler(ports)({ id: "fuel" })).rejects.toThrow(
      "not a live category"
    );
    await expect(categoryArchiveHandler(ports)({ id: "income" })).rejects.toThrow(
      "cannot be archived"
    );
  });
});
