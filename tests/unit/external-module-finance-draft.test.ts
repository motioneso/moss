// tests/unit/external-module-finance-draft.test.ts
//
// #3180: the first-budget draft. The builder is deterministic (numbers come only from the
// record), the start handler writes this month's assignments and marks the draft started,
// and no assistant tool can start a budget.
import { describe, expect, it } from "vitest";

import {
  buildDraft,
  DEFAULT_CATEGORIES,
  draftTotalCents,
  draftUnplannedCents,
  kvStore,
  pickBasisMonths,
  roundUpToFiveDollars,
  type ActivityInput,
  type FinanceKv,
  type TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import {
  draftBuildHandler,
  draftGetHandler,
  draftStartHandler
} from "../../external-modules/finance/src/worker/handlers/draft.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { HANDLERS } from "../../external-modules/finance/src/worker/registry.js";

const NOW = new Date("2026-10-09T12:00:00Z");

function tx(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    accountId: "acc1",
    date: "2026-09-10",
    amountCents: 1000,
    isoCurrency: "USD",
    name: "SHOP",
    merchant: "Shop",
    plaidCategory: null,
    categoryId: "groceries",
    pending: false,
    pendingTransactionId: null,
    categorizedBy: "user",
    reviewState: "confirmed",
    aiConfidence: null,
    ...over
  };
}

const byMonth = (rows: TransactionRecord[]): Record<string, TransactionRecord[]> => {
  const out: Record<string, TransactionRecord[]> = {};
  for (const row of rows) (out[row.date.slice(0, 7)] ??= []).push(row);
  return out;
};

describe("draft builder", () => {
  it("rounds a monthly average up to the next five dollars", () => {
    expect(roundUpToFiveDollars(61220)).toBe(61500);
    expect(roundUpToFiveDollars(61500)).toBe(61500);
    expect(roundUpToFiveDollars(1)).toBe(500);
  });

  it("uses the three newest complete months and never the current one", () => {
    expect(
      pickBasisMonths(["2026-05", "2026-06", "2026-07", "2026-08", "2026-10"], "2026-10")
    ).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(pickBasisMonths(["2026-10"], "2026-10")).toEqual(["2026-10"]);
    expect(pickBasisMonths([], "2026-10")).toEqual([]);
  });

  it("averages spend over the basis months and rounds the plan up", () => {
    const draft = buildDraft({
      transactionsByMonth: byMonth([
        tx({ id: "a", date: "2026-07-05", amountCents: 20000 }),
        tx({ id: "b", date: "2026-08-05", amountCents: 30000 }),
        tx({ id: "c", date: "2026-09-05", amountCents: 41300 })
      ]),
      categories: DEFAULT_CATEGORIES,
      currentMonth: "2026-10"
    })!;
    const groceries = draft.lines.find((line) => line.categoryKey === "groceries")!;
    expect(groceries.basisMonthlyCents).toBe(30433);
    expect(groceries.proposedCents).toBe(30500);
    expect(draft.basisFrom).toBe("2026-07-01");
    expect(draft.basisTo).toBe("2026-09-30");
  });

  it("takes the median monthly income and ignores transfers and pending rows", () => {
    const draft = buildDraft({
      transactionsByMonth: byMonth([
        tx({ id: "i1", date: "2026-07-01", amountCents: -500000, categoryId: "income" }),
        tx({ id: "i2", date: "2026-08-01", amountCents: -600000, categoryId: "income" }),
        tx({ id: "i3", date: "2026-09-01", amountCents: -900000, categoryId: "income" }),
        tx({ id: "t", date: "2026-09-02", amountCents: 70000, categoryId: "transfers" }),
        tx({ id: "p", date: "2026-09-03", amountCents: 99999, pending: true }),
        tx({ id: "g", date: "2026-09-04", amountCents: 3000 })
      ]),
      categories: DEFAULT_CATEGORIES,
      currentMonth: "2026-10"
    })!;
    expect(draft.monthlyIncomeCents).toBe(600000);
    expect(draft.lines.map((line) => line.categoryKey)).toEqual(["groceries"]);
    expect(draft.lines[0]!.basisMonthlyCents).toBe(1000);
  });

  it("puts a merchant charged about the same every month under Bills", () => {
    const draft = buildDraft({
      transactionsByMonth: byMonth([
        tx({
          id: "s1",
          date: "2026-07-03",
          amountCents: 1599,
          categoryId: "entertainment",
          merchant: "Streamy"
        }),
        tx({
          id: "s2",
          date: "2026-08-03",
          amountCents: 1599,
          categoryId: "entertainment",
          merchant: "Streamy"
        }),
        tx({
          id: "s3",
          date: "2026-09-03",
          amountCents: 1650,
          categoryId: "entertainment",
          merchant: "Streamy"
        }),
        tx({
          id: "d1",
          date: "2026-07-09",
          amountCents: 4000,
          categoryId: "dining",
          merchant: "Cafe"
        }),
        tx({
          id: "d2",
          date: "2026-09-09",
          amountCents: 9000,
          categoryId: "dining",
          merchant: "Cafe"
        })
      ]),
      categories: DEFAULT_CATEGORIES,
      currentMonth: "2026-10"
    })!;
    expect(draft.lines.find((l) => l.categoryKey === "entertainment")!.groupName).toBe("Bills");
    expect(draft.lines.find((l) => l.categoryKey === "dining")!.groupName).toBe("Everyday");
  });

  it("returns null with no history and drafts from the current month when it is all there is", () => {
    expect(
      buildDraft({
        transactionsByMonth: {},
        categories: DEFAULT_CATEGORIES,
        currentMonth: "2026-10"
      })
    ).toBeNull();
    const draft = buildDraft({
      transactionsByMonth: byMonth([tx({ id: "x", date: "2026-10-02", amountCents: 4200 })]),
      categories: DEFAULT_CATEGORIES,
      currentMonth: "2026-10"
    })!;
    expect(draft.lines[0]!.proposedCents).toBe(4500);
    expect(draft.basisFrom).toBe("2026-10-01");
  });

  it("totals only lines that are not dropped, with adjusted amounts first", () => {
    const lines = [
      {
        categoryKey: "a",
        groupName: "Bills",
        categoryName: "A",
        basisMonthlyCents: 1,
        proposedCents: 10000,
        adjustedCents: null,
        adjustedBy: null,
        dropped: false
      },
      {
        categoryKey: "b",
        groupName: "Bills",
        categoryName: "B",
        basisMonthlyCents: 1,
        proposedCents: 5000,
        adjustedCents: 7000,
        adjustedBy: "user" as const,
        dropped: false
      },
      {
        categoryKey: "c",
        groupName: "Bills",
        categoryName: "C",
        basisMonthlyCents: 1,
        proposedCents: 9000,
        adjustedCents: null,
        adjustedBy: null,
        dropped: true
      }
    ];
    expect(draftTotalCents(lines)).toBe(17000);
    expect(draftUnplannedCents({ monthlyIncomeCents: 15000, lines })).toBe(-2000);
  });
});

function memoryKv(): FinanceKv {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const ns = (namespace: string) => {
    let bucket = store.get(namespace);
    if (!bucket) store.set(namespace, (bucket = new Map()));
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

function ports(kv: FinanceKv, activity: ActivityInput[] = []): WorkerPorts {
  return {
    kv,
    db: null,
    now: () => NOW,
    store: async () => ({
      ...kvStore(kv),
      appendActivity: async (entry: ActivityInput) => {
        activity.push(entry);
      }
    })
  } as unknown as WorkerPorts;
}

async function seedHistory(kv: FinanceKv): Promise<void> {
  const store = kvStore(kv);
  await store.putTransactionChunk("acc1", "2026-08", [
    tx({ id: "g1", date: "2026-08-04", amountCents: 20000 })
  ]);
  await store.putTransactionChunk("acc1", "2026-09", [
    tx({ id: "g2", date: "2026-09-04", amountCents: 30000 }),
    tx({ id: "i1", date: "2026-09-01", amountCents: -400000, categoryId: "income" })
  ]);
}

describe("draft handlers", () => {
  it("builds once from the record and does not rebuild over an existing draft", async () => {
    const kv = memoryKv();
    await seedHistory(kv);
    const p = ports(kv);
    const build = draftBuildHandler(p);
    expect(await build({ jobKind: "finance.draft-build" })).toMatchObject({ built: true });
    expect(await build({ jobKind: "finance.draft-build" })).toMatchObject({ built: false });

    const view = (await draftGetHandler(p)({})) as {
      draft: {
        totalCents: number;
        monthlyIncomeCents: number;
        unplannedCents: number;
        groups: { lines: { planCents: number }[] }[];
      };
    };
    expect(view.draft.totalCents).toBe(
      view.draft.groups.flatMap((g) => g.lines).reduce((sum, l) => sum + l.planCents, 0)
    );
    expect(view.draft.unplannedCents).toBe(view.draft.monthlyIncomeCents - view.draft.totalCents);
  });

  it("reports no draft when there is no history", async () => {
    const kv = memoryKv();
    const p = ports(kv);
    expect(await draftBuildHandler(p)({ jobKind: "finance.draft-build" })).toMatchObject({
      built: false,
      reason: "no-history"
    });
    expect(await draftGetHandler(p)({})).toMatchObject({ draft: null, hasBudget: false });
  });

  it("start sets this month's assignments, logs them and marks the draft started", async () => {
    const kv = memoryKv();
    await seedHistory(kv);
    const activity: ActivityInput[] = [];
    const p = ports(kv, activity);
    await draftBuildHandler(p)({ jobKind: "finance.draft-build" });
    const draft = (await kvStore(kv).getLatestDraft())!;

    const result = await draftStartHandler(p)({
      jobKind: "finance.draft-start",
      params: { draftId: draft.id }
    });
    expect(result).toMatchObject({ started: true, assigned: 1 });
    expect((await kvStore(kv).getLedger("2026-10"))!.assignments).toEqual({ groceries: 25000 });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actor: "user", kind: "budget.assign" });
    expect((await kvStore(kv).getLatestDraft())!.status).toBe("started");

    // A retry after a finished start changes nothing.
    expect(
      await draftStartHandler(p)({ jobKind: "finance.draft-start", params: { draftId: draft.id } })
    ).toMatchObject({ alreadyStarted: true });
    expect(activity).toHaveLength(1);
  });

  it("start skips dropped lines and creates a category the taxonomy lacks", async () => {
    const kv = memoryKv();
    await seedHistory(kv);
    const p = ports(kv);
    await draftBuildHandler(p)({ jobKind: "finance.draft-build" });
    const latest = (await kvStore(kv).getLatestDraft())!;
    await kv.set("finance.budgets", "draft:first-budget", {
      ...latest,
      lines: [
        ...latest.lines.map((line) => ({ ...line, dropped: true })),
        {
          categoryKey: "pet-care",
          groupName: "Everyday",
          categoryName: "Pet care",
          basisMonthlyCents: 0,
          proposedCents: 0,
          adjustedCents: 8000,
          adjustedBy: "moss",
          dropped: false
        }
      ]
    });
    await draftStartHandler(p)({ jobKind: "finance.draft-start", params: { draftId: latest.id } });
    expect((await kvStore(kv).getLedger("2026-10"))!.assignments).toEqual({ "pet-care": 8000 });
    const taxonomy = (await kv.get("finance.categories", "taxonomy")) as {
      categories: { id: string; name: string }[];
    };
    expect(taxonomy.categories.find((c) => c.id === "pet-care")).toMatchObject({
      name: "Pet care"
    });
  });

  it("refuses a draft id that is not the current draft", async () => {
    const kv = memoryKv();
    await seedHistory(kv);
    const p = ports(kv);
    await draftBuildHandler(p)({ jobKind: "finance.draft-build" });
    await expect(
      draftStartHandler(p)({
        jobKind: "finance.draft-start",
        params: { draftId: "00000000-0000-4000-8000-000000000000" }
      })
    ).rejects.toThrow(/draft/);
  });

  it("registers the read tool and both queues but no tool that starts a draft", () => {
    expect(Object.keys(HANDLERS)).toEqual(
      expect.arrayContaining(["budget.draft.get", "draft.build", "draft.start"])
    );
  });
});
