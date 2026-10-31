import { describe, expect, it } from "vitest";

import {
  buildAccountsView,
  syncedAgo,
  type AccountsBank,
  type AccountsRow
} from "../../external-modules/finance/src/web/accounts-view.js";

// #3177: the Accounts screen is built from one read. This view model decides
// which bank is stale, what the status line says, and the net worth figure.

const NOW = new Date("2026-10-08T12:00:00Z");

function row(overrides: Partial<AccountsRow> & { accountId: string; itemId: string }) {
  return {
    name: "Checking",
    mask: "4821",
    type: "depository",
    balanceCents: 100,
    isoCurrency: "USD",
    ...overrides
  } satisfies AccountsRow;
}

const healthy: AccountsBank = {
  itemId: "i1",
  institutionId: "ins_1",
  status: "connected",
  lastSyncAt: "2026-10-08T10:00:00Z",
  message: null
};

const expired: AccountsBank = {
  itemId: "i2",
  institutionId: "ins_2",
  status: "reauth-required",
  lastSyncAt: "2026-10-05T09:00:00Z",
  message: "The login details of this item have changed."
};

describe("syncedAgo", () => {
  it("says minutes, hours and days in plain words", () => {
    expect(syncedAgo("2026-10-08T11:59:30Z", NOW)).toBe("Synced just now");
    expect(syncedAgo("2026-10-08T11:15:00Z", NOW)).toBe("Synced 45 minutes ago");
    expect(syncedAgo("2026-10-08T10:00:00Z", NOW)).toBe("Synced 2 hours ago");
    expect(syncedAgo("2026-10-08T11:00:00Z", NOW)).toBe("Synced 1 hour ago");
    expect(syncedAgo("2026-10-06T12:00:00Z", NOW)).toBe("Synced 2 days ago");
    expect(syncedAgo(null, NOW)).toBe("Not synced yet");
  });
});

describe("buildAccountsView", () => {
  const accounts: AccountsRow[] = [
    row({ accountId: "a1", itemId: "i1", name: "Checking", balanceCents: 348210 }),
    row({
      accountId: "a2",
      itemId: "i1",
      name: "Visa",
      mask: "1190",
      type: "credit",
      balanceCents: 61244
    }),
    row({
      accountId: "a3",
      itemId: "i2",
      name: "Savings",
      mask: "7302",
      balanceCents: 921000
    })
  ];

  it("groups accounts under their bank and signs card debt as negative", () => {
    const view = buildAccountsView(accounts, [healthy, expired], NOW);
    expect(view.banks).toHaveLength(2);
    expect(view.banks[0]!.accounts.map((a) => [a.name, a.balanceCents])).toEqual([
      ["Checking", 348210],
      ["Visa", -61244]
    ]);
  });

  it("totals net worth as assets less debts", () => {
    const view = buildAccountsView(accounts, [healthy, expired], NOW);
    expect(view.netWorthByCurrency).toEqual([
      { currency: "USD", netWorthCents: 348210 - 61244 + 921000 }
    ]);
  });

  it("keeps currencies separate even within one bank and retains every row's currency", () => {
    const view = buildAccountsView(
      [
        row({ accountId: "usd", itemId: "i1", balanceCents: 10000 }),
        row({ accountId: "eur", itemId: "i1", balanceCents: 2345, isoCurrency: "EUR" }),
        row({
          accountId: "loan",
          itemId: "i1",
          balanceCents: 1200,
          isoCurrency: "EUR",
          type: "loan"
        })
      ],
      [healthy],
      NOW
    );
    expect(view.netWorthByCurrency).toEqual([
      { currency: "EUR", netWorthCents: 1145 },
      { currency: "USD", netWorthCents: 10000 }
    ]);
    expect(view.banks[0]!.accounts.map((account) => account.isoCurrency)).toEqual([
      "USD",
      "EUR",
      "EUR"
    ]);
  });

  it("does not round overflowing totals or hide individual balances", () => {
    const view = buildAccountsView(
      [
        row({ accountId: "large", itemId: "i1", balanceCents: Number.MAX_SAFE_INTEGER }),
        row({ accountId: "extra", itemId: "i1", balanceCents: 1 }),
        row({ accountId: "eur", itemId: "i1", balanceCents: 250, isoCurrency: "EUR" })
      ],
      [healthy],
      NOW
    );
    expect(view.netWorthByCurrency).toEqual([
      { currency: "EUR", netWorthCents: 250 },
      { currency: "USD", netWorthCents: null }
    ]);
    expect(view.banks[0]!.accounts).toHaveLength(3);
  });

  it("accumulates exactly before testing whether a final total can be displayed", () => {
    const view = buildAccountsView(
      [
        row({ accountId: "large", itemId: "i1", balanceCents: Number.MAX_SAFE_INTEGER }),
        row({ accountId: "extra", itemId: "i1", balanceCents: 2 }),
        row({ accountId: "debt", itemId: "i1", balanceCents: 3, type: "credit" })
      ],
      [healthy],
      NOW
    );
    expect(view.netWorthByCurrency).toEqual([
      { currency: "USD", netWorthCents: Number.MAX_SAFE_INTEGER - 1 }
    ]);
  });

  it("marks a healthy bank ready with a synced-ago line", () => {
    const view = buildAccountsView(accounts, [healthy, expired], NOW);
    expect(view.banks[0]).toMatchObject({
      status: "ready",
      statusLabel: "Synced 2 hours ago",
      reconnect: false,
      asOf: null,
      message: null
    });
  });

  it("shows an expired sign-in with its stored message, as-of date and Reconnect", () => {
    const view = buildAccountsView(accounts, [healthy, expired], NOW);
    expect(view.banks[1]).toMatchObject({
      status: "error",
      statusLabel: "Sign-in expired",
      reconnect: true,
      asOf: "October 5",
      message: "The login details of this item have changed."
    });
  });

  it("flags a connection error without offering Reconnect", () => {
    const broken: AccountsBank = { ...expired, itemId: "i2", status: "error", message: null };
    const view = buildAccountsView(accounts, [healthy, broken], NOW);
    expect(view.banks[1]).toMatchObject({
      status: "error",
      statusLabel: "Connection problem",
      reconnect: false
    });
  });

  it("names banks plainly when only an institution id is stored", () => {
    expect(buildAccountsView(accounts.slice(0, 1), [healthy], NOW).banks[0]!.name).toBe(
      "Connected bank"
    );
    expect(buildAccountsView(accounts, [healthy, expired], NOW).banks.map((b) => b.name)).toEqual([
      "Bank 1",
      "Bank 2"
    ]);
  });

  it("uses the stored bank name and falls back to the plain label when none is known", () => {
    const named = { ...healthy, institutionName: "Sandbox First Bank" };
    expect(buildAccountsView(accounts.slice(0, 1), [named], NOW).banks[0]!.name).toBe(
      "Sandbox First Bank"
    );
    const view = buildAccountsView(accounts, [named, expired], NOW);
    expect(view.banks.map((b) => b.name)).toEqual(["Sandbox First Bank", "Bank 2"]);
    const blank = { ...healthy, institutionName: "  " };
    expect(buildAccountsView(accounts.slice(0, 1), [blank], NOW).banks[0]!.name).toBe(
      "Connected bank"
    );
  });

  it("is empty with no accounts", () => {
    const view = buildAccountsView([], [], NOW);
    expect(view.banks).toEqual([]);
    expect(view.groups).toEqual([]);
    expect(view.netWorthByCurrency).toEqual([]);
    expect(view.sidesByCurrency).toEqual([]);
  });
});

describe("Accounts grouped by kind", () => {
  const accounts: AccountsRow[] = [
    row({ accountId: "card", itemId: "i1", name: "Card", type: "credit", balanceCents: 4000 }),
    row({ accountId: "chk", itemId: "i1", name: "Checking", balanceCents: 10000 }),
    row({
      accountId: "brk",
      itemId: "i2",
      name: "Brokerage",
      type: "investment",
      balanceCents: 500
    }),
    {
      ...row({ accountId: "wallet", itemId: "", name: "Wallet", type: "other", balanceCents: 900 }),
      itemId: null,
      source: "manual",
      subtype: "cash"
    },
    {
      ...row({ accountId: "car", itemId: "", name: "Car", type: "other", balanceCents: 700 }),
      itemId: null,
      source: "manual",
      subtype: "asset"
    },
    row({ accountId: "mort", itemId: "i1", name: "Mortgage", type: "loan", balanceCents: 2000 })
  ];

  it("orders assets before debts and puts cash on hand with checking", () => {
    const view = buildAccountsView(accounts, [healthy, expired], NOW);
    expect(view.groups.map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
      ["Cash", ["Checking", "Wallet"]],
      ["Investments", ["Brokerage"]],
      ["Credit cards", ["Card"]],
      ["Loans", ["Mortgage"]],
      ["Other", ["Car"]]
    ]);
  });

  it("totals each group in its own currency, debts negative", () => {
    const view = buildAccountsView(
      [...accounts, row({ accountId: "eur", itemId: "i1", name: "Euro", isoCurrency: "EUR" })],
      [healthy, expired],
      NOW
    );
    const totals = Object.fromEntries(view.groups.map((g) => [g.kind, g.totals]));
    expect(totals.cash).toEqual([
      { currency: "EUR", cents: 100 },
      { currency: "USD", cents: 10900 }
    ]);
    expect(totals.credit).toEqual([{ currency: "USD", cents: -4000 }]);
    expect(totals.loan).toEqual([{ currency: "USD", cents: -2000 }]);
  });

  it("splits net worth into assets and debts owed", () => {
    const view = buildAccountsView(accounts, [healthy, expired], NOW);
    expect(view.netWorthByCurrency).toEqual([{ currency: "USD", netWorthCents: 6100 }]);
    expect(view.sidesByCurrency).toEqual([
      { currency: "USD", assetsCents: 12100, debtsCents: 6000 }
    ]);
  });

  it("names where each balance comes from, with an as-of date for a stale bank", () => {
    const view = buildAccountsView(
      accounts,
      [
        { ...healthy, institutionName: "Sandbox First Bank" },
        { ...expired, institutionName: "Sandbox Brokerage" }
      ],
      NOW
    );
    const source = Object.fromEntries(
      view.groups.flatMap((g) => g.rows.map((r) => [r.name, [r.manual, r.source]]))
    );
    expect(source.Checking).toEqual([false, "Sandbox First Bank · Synced 2 hours ago"]);
    expect(source.Brokerage).toEqual([false, "Sandbox Brokerage · As of October 5"]);
    expect(source.Wallet).toEqual([true, "Manual"]);
  });
});
