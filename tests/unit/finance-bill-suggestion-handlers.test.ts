// #3877: the bill suggestion read and dismiss tools over a scripted store. The domain rules have
// their own test; this pins what the handler feeds them and what it refuses.
import { describe, expect, it, vi } from "vitest";
import type { BillPlan } from "../../external-modules/finance/src/domain/bills.js";
import type { SuggestionDismissal } from "../../external-modules/finance/src/domain/bill-suggestions.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/index.js";
import {
  billSuggestionDismissHandler,
  billSuggestionsReadHandler
} from "../../external-modules/finance/src/worker/handlers/bill-suggestions.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

const NOW = new Date("2026-10-01T12:00:00Z");

const charge = (
  id: string,
  date: string,
  name: string,
  over: Partial<TransactionRecord> = {}
): TransactionRecord => ({
  id,
  accountId: "cash",
  date,
  amountCents: 1599,
  isoCurrency: "USD",
  name,
  merchant: null,
  plaidCategory: null,
  categoryId: "subscriptions",
  pending: false,
  pendingTransactionId: null,
  categorizedBy: null,
  ...over
});

/** Three monthly charges ending mid-September, so the next one is due mid-October. */
const monthly = (key: string, name: string, over: Partial<TransactionRecord> = {}) =>
  ["2026-07-15", "2026-08-15", "2026-09-15"].map((date, i) =>
    charge(`${key}-${i}`, date, name, over)
  );

const account = (accountId: string, over: Record<string, unknown> = {}) => ({
  accountId,
  name: `Synthetic ${accountId}`,
  isoCurrency: "USD",
  archivedAt: null,
  ...over
});

function fixture(
  opts: {
    rows?: TransactionRecord[];
    plans?: BillPlan[];
    dismissals?: SuggestionDismissal[];
    claimed?: string[];
    policy?: boolean;
    withSuggestions?: boolean;
  } = {}
) {
  const rows = opts.rows ?? monthly("film", "Synthetic Film Club");
  const dismiss = vi.fn(async () => true);
  const store = {
    budgetPolicy: {
      get: async () =>
        opts.policy === false
          ? null
          : { revision: 1, fingerprint: "a".repeat(32), isoCurrency: "USD", taxonomyReady: true },
      categories: async () => []
    },
    bills: { plans: async () => opts.plans ?? [], decisions: async () => [] },
    billAdjustments: {
      claimedTransactionIds: async (ids: readonly string[]) =>
        ids.filter((id) => (opts.claimed ?? []).includes(id))
    },
    billSuggestions:
      opts.withSuggestions === false
        ? undefined
        : { dismissals: async () => opts.dismissals ?? [], dismiss },
    listAccounts: async () => [
      account("cash"),
      account("euro", { isoCurrency: "EUR" }),
      account("closed", { archivedAt: "2026-09-30T00:00:00Z" })
    ],
    listTransactionMonths: async () => [...new Set(rows.map((r) => r.date.slice(0, 7)))],
    listMonthTransactions: async (month: string) => rows.filter((r) => r.date.startsWith(month))
  };
  const ports = {
    store: async () => store,
    now: () => NOW,
    localTimezone: "UTC"
  } as unknown as WorkerPorts;
  return { ports, dismiss };
}

const read = async (f: ReturnType<typeof fixture>) =>
  (await billSuggestionsReadHandler(f.ports)({})) as {
    status: string;
    setupRequired?: boolean;
    suggestions?: { name: string; payeeKey: string; accountName: string | null }[];
  };

describe("finance.bills.suggestions", () => {
  it("suggests a steady monthly charge with its account name", async () => {
    const result = await read(fixture());
    expect(result.suggestions).toEqual([
      expect.objectContaining({
        name: "Synthetic Film Club",
        payeeKey: "synthetic film club",
        cadence: "monthly",
        amountCents: 1599,
        nextDate: "2026-10-15",
        accountName: "Synthetic cash"
      })
    ]);
  });

  it("asks for the budget currency first", async () => {
    expect(await read(fixture({ policy: false }))).toEqual({ status: "ok", setupRequired: true });
  });

  it("leaves out rows that are not the owner's spending in the budget currency", async () => {
    const result = await read(
      fixture({
        rows: [
          ...monthly("pending", "Synthetic Pending", { pending: true }),
          ...monthly("pay", "Synthetic Payroll", { categoryId: "income" }),
          ...monthly("move", "Synthetic Move", { categoryId: "transfers" }),
          ...monthly("pair", "Synthetic Pair", { transferId: "t-1" }),
          ...monthly("refund", "Synthetic Refund", { amountCents: -1599 }),
          ...monthly("euro", "Synthetic Euro", { accountId: "euro", isoCurrency: "EUR" }),
          ...monthly("closed", "Synthetic Closed", { accountId: "closed" }),
          ...monthly("claimed", "Synthetic Claimed")
        ],
        claimed: ["claimed-0", "claimed-1", "claimed-2"]
      })
    );
    expect(result.suggestions).toEqual([]);
  });

  it("drops a charge an active plan covers, but not one a stopped plan covered", async () => {
    const plan: BillPlan = {
      id: "94bfda66-d527-4b21-8f42-11dfe10408db",
      name: "Synthetic Film Club",
      accountId: "cash",
      categoryId: "subscriptions",
      isoCurrency: "USD",
      amountCents: 1599,
      anchorDate: "2026-07-15",
      cadence: "monthly"
    };
    expect((await read(fixture({ plans: [plan] }))).suggestions).toEqual([]);
    expect(
      (await read(fixture({ plans: [{ ...plan, endDate: "2026-09-15" }] }))).suggestions
    ).toHaveLength(1);
  });

  it("hides a dismissed suggestion", async () => {
    const dismissals: SuggestionDismissal[] = [
      { accountId: "cash", payeeKey: "synthetic film club", cadence: "monthly", amountCents: 1599 }
    ];
    expect((await read(fixture({ dismissals }))).suggestions).toEqual([]);
  });

  it("asks for a storage update when the dismissal table is missing", async () => {
    await expect(read(fixture({ withSuggestions: false }))).rejects.toMatchObject({
      code: "storage_upgrade_required"
    });
  });
});

describe("finance.bills.suggestions.dismiss", () => {
  const input = {
    accountId: "cash",
    payeeKey: "synthetic film club",
    cadence: "monthly",
    amountCents: 1599
  };

  it("saves the key fields with the current time", async () => {
    const f = fixture();
    expect(await billSuggestionDismissHandler(f.ports)(input)).toEqual({ status: "ok", ...input });
    expect(f.dismiss).toHaveBeenCalledWith(
      { accountId: "cash", payeeKey: "synthetic film club", cadence: "monthly", amountCents: 1599 },
      NOW.toISOString()
    );
  });

  it.each([
    ["a raw payee name", { payeeKey: "Synthetic Film Club #42" }],
    ["an empty payee key", { payeeKey: "" }],
    ["a one-off cadence", { cadence: "once" }],
    ["a zero amount", { amountCents: 0 }],
    ["a fractional amount", { amountCents: 15.5 }]
  ])("refuses %s", async (_label, change) => {
    const f = fixture();
    await expect(billSuggestionDismissHandler(f.ports)({ ...input, ...change })).rejects.toThrow();
    expect(f.dismiss).not.toHaveBeenCalled();
  });

  it("measures the key length in characters, up to 160", async () => {
    const astral = "\u{1D41A}";
    for (const payeeKey of ["a".repeat(160), astral.repeat(160)]) {
      const f = fixture();
      await billSuggestionDismissHandler(f.ports)({ ...input, payeeKey });
      expect(f.dismiss).toHaveBeenCalledOnce();
    }
    for (const payeeKey of ["a".repeat(161), astral.repeat(161)]) {
      const f = fixture();
      await expect(billSuggestionDismissHandler(f.ports)({ ...input, payeeKey })).rejects.toThrow();
      expect(f.dismiss).not.toHaveBeenCalled();
    }
  });

  it("dismisses a suggestion whose payee name was longer than the key allows", async () => {
    const name = "Synthetic Film Club ".repeat(12);
    const f = fixture({ rows: monthly("long", name) });
    const { suggestions } = await read(f);
    const payeeKey = suggestions![0]!.payeeKey;

    // The cut falls on a space, so the key ends at the word before it.
    expect(payeeKey).toHaveLength(159);
    expect(payeeKey.endsWith("club")).toBe(true);
    expect(await billSuggestionDismissHandler(f.ports)({ ...input, payeeKey })).toMatchObject({
      status: "ok",
      payeeKey
    });
    expect(f.dismiss).toHaveBeenCalledOnce();
  });

  it("refuses an account that is not the owner's", async () => {
    const f = fixture();
    f.dismiss.mockResolvedValueOnce(false);
    await expect(billSuggestionDismissHandler(f.ports)(input)).rejects.toThrow(
      "Choose one of your accounts"
    );
  });
});
