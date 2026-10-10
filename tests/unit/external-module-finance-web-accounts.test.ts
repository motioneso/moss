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
    expect(view.netWorthCents).toBe(348210 - 61244 + 921000);
    expect(view.currency).toBe("USD");
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
    expect(view.netWorthCents).toBe(0);
  });
});
