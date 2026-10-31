import { describe, it, expect } from "vitest";
import { deriveReportDetails } from "../../external-modules/finance/src/domain/report-details.js";
import { aggregateSpending } from "../../external-modules/finance/src/domain/reports.js";
import { excludeTransfers } from "../../external-modules/finance/src/domain/transfers.js";
import { reportsTransactionsHandler } from "../../external-modules/finance/src/worker/handlers/report-details.js";
import { reportsSpendingHandler } from "../../external-modules/finance/src/worker/handlers/reports.js";
import { readWindow } from "../../external-modules/finance/src/worker/handlers/report-rows.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
import type { FinanceStore } from "../../external-modules/finance/src/domain/store-port.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const row = (id: string, extra: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id,
  accountId: "synthetic",
  date: "2026-10-15",
  amountCents: 100,
  isoCurrency: "USD",
  name: "Synthetic merchant",
  merchant: null,
  plaidCategory: null,
  categoryId: "groceries",
  pending: false,
  pendingTransactionId: null,
  categorizedBy: "user",
  notes: "Synthetic private note",
  ...extra
});
const own = [
  row("mixed", {
    name: "Mixed",
    splits: [
      { categoryId: "income", amountCents: -50 },
      { categoryId: "groceries", amountCents: 150 }
    ]
  }),
  row("refund", { amountCents: -20 }),
  row("pending", { amountCents: 30, pending: true }),
  row("transfer-out", {
    accountId: "other",
    date: "2026-09-30",
    categoryId: "transfers",
    amountCents: 40
  }),
  row("transfer-in", { date: "2026-10-01", amountCents: -40 }),
  row("eur", { isoCurrency: "EUR" }),
  row("unbalanced", { splits: [{ categoryId: "groceries", amountCents: 90 }] })
];
const source = (transactions = own) => [{ ownerUserId: "owner", shared: false, transactions }];
const scope = { month: "2026-10", currency: "USD", group: "category" as const, key: "groceries" };
function scriptedPorts(transactions = own, shared: Record<string, TransactionRecord[]> = {}) {
  const store = {
    listMonthTransactions: async (month: string) =>
      transactions.filter((r) => r.date.startsWith(month)),
    listAccounts: async () => []
  } as unknown as FinanceStore;
  return {
    store: async () => store,
    now: () => new Date("2026-10-30T00:00:00Z"),
    localTimezone: "UTC",
    kv: { get: async () => null },
    mirror: {
      list: async () => Object.keys(shared),
      get: async (key: string) => ({ transactions: shared[key] })
    }
  } as unknown as WorkerPorts;
}
const input = { actorUserId: "owner", activeUserIds: ["owner", "member"], months: 6, ...scope };
describe("faithful report transaction contributions", () => {
  it("reconciles category, payee, income and outflow with splits, refunds, pending and invalidated splits", () => {
    const aggregate = aggregateSpending(
      excludeTransfers(own).filter((r) => r.isoCurrency === "USD"),
      ["2026-10"]
    )[0]!;
    for (const group of ["category", "payee", "income", "outflow"] as const) {
      const key = group === "payee" ? "Mixed" : "groceries";
      const details = deriveReportDetails(source(), { ...scope, group, key }, 0, 200);
      const expected =
        group === "category"
          ? aggregate.byCategory.groceries
          : group === "payee"
            ? aggregate.byPayee.Mixed
            : group === "income"
              ? aggregate.cashFlow.incomeCents
              : aggregate.cashFlow.outflowCents;
      expect(details.totalCents).toBe(expected);
    }
    const category = deriveReportDetails(source(), scope, 0, 200);
    expect(category.totalCents).toBe(160);
    expect(category.rows.find((r) => r.id === "mixed")).toMatchObject({
      amountCents: 150,
      parentAmountCents: 100
    });
    expect(category.rows.find((r) => r.id === "pending")?.pending).toBe(true);
    expect(
      deriveReportDetails(source(), { ...scope, key: "uncategorized" }, 0, 200).totalCents
    ).toBe(100);
  });
  it("never pairs two owners' equal opposite entries and omits unrequested currencies", () => {
    const result = deriveReportDetails(
      [
        {
          ownerUserId: "owner",
          shared: false,
          transactions: [row("out", { categoryId: "transfers", amountCents: 50 })]
        },
        {
          ownerUserId: "member",
          shared: true,
          transactions: [
            row("in", { accountId: "shared", amountCents: -50 }),
            row("eur", { isoCurrency: "EUR" })
          ]
        }
      ],
      scope,
      0,
      200
    );
    expect(result.totalCents).toBe(-50);
    expect(result.rows.map((r) => r.ownerUserId)).toEqual(["member"]);
  });
  it("keeps the whole total/count separate from the bounded page and excludes notes and extras", () => {
    const rows = Array.from({ length: 201 }, (_, i) =>
      row(`synthetic:${String(i).padStart(3, "0")}`, { amountCents: 1 })
    );
    const result = deriveReportDetails(source(rows), scope, 200, 50);
    expect(result).toMatchObject({ totalCount: 201, totalCents: 201, offset: 200, limit: 50 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe("synthetic:200");
    expect(result.rows[0]).not.toHaveProperty("notes");
    expect(JSON.stringify(result)).not.toContain("Synthetic private note");
  });
  it("sums cancelling safe integers exactly and rejects an unsafe public total", () => {
    const large = Number.MAX_SAFE_INTEGER;
    expect(
      deriveReportDetails(
        source([
          row("a", { amountCents: large }),
          row("b", { amountCents: 1 }),
          row("c", { amountCents: -large })
        ]),
        scope,
        0,
        200
      ).totalCents
    ).toBe(1);
    expect(() =>
      deriveReportDetails(
        source([row("a", { amountCents: large }), row("b", { amountCents: 1 })]),
        scope,
        0,
        200
      )
    ).toThrow();
  });
  it("limits selected shared owners to active mirrored rows and returns only allowlisted data", async () => {
    const ports = scriptedPorts([row("own")], {
      "member:shared:2026-10": [row("shared", { notes: "Synthetic shared private note" })],
      "inactive:shared:2026-10": [row("inactive", { amountCents: 999 })],
      "owner:synthetic:2026-10": [row("own-mirror", { amountCents: 999 })]
    });
    const result = await reportsTransactionsHandler(ports)({
      ...input,
      sharedOwnerIds: ["member", "inactive", "unknown"]
    });
    expect(result).toMatchObject({ totalCount: 2, totalCents: 200 });
    expect((result.rows as { ownerUserId: string }[]).map((r) => r.ownerUserId).sort()).toEqual([
      "member",
      "owner"
    ]);
    expect(JSON.stringify(result)).not.toContain("private note");
    const ownOnly = await reportsTransactionsHandler(ports)(input);
    expect(ownOnly).toMatchObject({ totalCount: 1, totalCents: 100 });
  });
  it("keeps raw payee keys exact and uses the authenticated owner's month at UTC boundaries", async () => {
    const ports: WorkerPorts = {
      ...scriptedPorts([row("space", { name: "  Synthetic  ", amountCents: 100 })]),
      now: () => new Date("2026-11-01T03:00:00Z"),
      localTimezone: "America/Los_Angeles"
    };
    expect(readWindow({ months: 1 }, ports)).toEqual(["2026-10"]);
    expect(
      await reportsTransactionsHandler(ports)({
        ...input,
        group: "payee",
        key: "  Synthetic  ",
        months: 1
      })
    ).toMatchObject({ totalCents: 100 });
    const aggregate = await reportsSpendingHandler(ports)({ ...input, months: 1 });
    expect(aggregate.window).toEqual(["2026-10"]);
    await expect(
      reportsTransactionsHandler(ports)({ ...input, month: "2026-11", months: 1 })
    ).rejects.toThrow("report period changed");
  });
  it.each([
    { month: "2026-00" },
    { currency: "usd" },
    { group: "everything" },
    { offset: -1 },
    { limit: 201 },
    { months: 25 },
    { key: undefined },
    { sharedOwnerIds: [3] }
  ])("rejects invalid report scope: %j", async (change) => {
    await expect(
      reportsTransactionsHandler(scriptedPorts())({ ...input, ...change })
    ).rejects.toThrow();
  });
});
