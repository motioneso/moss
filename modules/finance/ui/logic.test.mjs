import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAmountToCents,
  centsToAmountInput,
  formatCents,
  shiftMonth,
  monthLabel
} from "./format.mjs";
import { buildGroups, saveFailure, amountFieldText } from "./budget-model.mjs";
import { buildAccountsView, accountKind, syncedAgo } from "./accounts-model.mjs";
import { requestParams, emptyFilters, filterCount, PAGE } from "./transactions-model.mjs";
import { accountRequest, entryRequest } from "./dialogs.mjs";

test("amount text reads into whole cents and rejects anything else", () => {
  assert.equal(parseAmountToCents("1,234.56"), 123456);
  assert.equal(parseAmountToCents("$50"), 5000);
  assert.equal(parseAmountToCents("-20"), -2000);
  assert.equal(parseAmountToCents("12.5"), 1250);
  assert.equal(parseAmountToCents("abc"), null);
  assert.equal(parseAmountToCents("1.234"), null);
  assert.equal(parseAmountToCents("999999999"), null);
  assert.equal(centsToAmountInput(-1205), "-12.05");
});

test("months step across a year end", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(monthLabel("2026-11"), "November 2026");
});

test("a debt balance shows negative and money formats with its currency", () => {
  assert.equal(formatCents(-123456, "USD"), "-$1,234.56");
});

const status = {
  isoCurrency: "USD",
  state: {
    categories: {
      rent: { assignedCents: 100000, activityCents: -90000, availableCents: 10000 },
      gone: { assignedCents: 0, activityCents: 0, availableCents: 0 },
      old: { assignedCents: 500, activityCents: 0, availableCents: 500 }
    }
  },
  categories: [
    { id: "rent", name: "Rent", tableGroup: "Fixed" },
    { id: "gone", name: "Gone", tableGroup: "Fixed", archived: true },
    { id: "old", name: "Old", tableGroup: "Fixed", archived: true },
    { id: "income", name: "Income", tableGroup: "Everyday" },
    { id: "food", name: "Food", tableGroup: "Everyday" }
  ]
};

test("budget groups keep income out and show archived rows only when they hold money", () => {
  const groups = buildGroups(status);
  assert.deepEqual(
    groups.map((g) => g.name),
    ["Fixed", "Everyday"]
  );
  assert.deepEqual(
    groups[0].lines.map((l) => l.id),
    ["rent", "old"]
  );
  assert.deepEqual(
    groups[1].lines.map((l) => l.id),
    ["food"]
  );
  assert.equal(groups[0].lines[0].spent, -90000);
});

test("a stale save and an unconfirmed save read differently", () => {
  assert.match(saveFailure({ code: "stale_budget" }), /may have changed/);
  assert.match(saveFailure({ status: 500 }), /could not be confirmed/);
  assert.equal(saveFailure({ status: 400, detail: "Too large" }), "Too large");
  assert.equal(amountFieldText(123456, "USD"), "$1,234.56");
});

test("accounts group by kind and debts count against net worth", () => {
  const accounts = [
    {
      accountId: "a",
      name: "Checking",
      type: "depository",
      balanceCents: 100000,
      isoCurrency: "USD",
      source: "plaid",
      itemId: "i1"
    },
    {
      accountId: "b",
      name: "Card",
      type: "credit",
      balanceCents: 30000,
      isoCurrency: "USD",
      source: "plaid",
      itemId: "i1"
    }
  ];
  const banks = [
    {
      itemId: "i1",
      institutionName: "First Bank",
      status: "reauth-required",
      lastSyncAt: "2026-11-10T00:00:00Z",
      message: "Sign in again"
    }
  ];
  const view = buildAccountsView(accounts, banks, new Date("2026-11-18T00:00:00Z"));
  assert.deepEqual(
    view.groups.map((g) => g.title),
    ["Cash", "Credit cards"]
  );
  assert.equal(view.net[0].cents, 70000);
  assert.equal(view.net[0].debts, 30000);
  assert.equal(view.banks[0].reconnect, true);
  assert.equal(view.banks[0].statusLabel, "Sign-in expired");
  assert.equal(accountKind("other", "cash"), "cash");
  assert.equal(syncedAgo(null, new Date()), "Not synced yet");
});

test("the transactions request carries month, search, filters and the page size", () => {
  const s = {
    month: "2026-11",
    search: " coffee ",
    view: "look",
    pages: 2,
    filters: { ...emptyFilters(), direction: "outflow", check: "duplicates" }
  };
  const p = requestParams(s);
  assert.equal(p.search, "coffee");
  assert.equal(p.needsLookOnly, true);
  assert.equal(p.duplicatesOnly, true);
  assert.equal(p.direction, "outflow");
  assert.equal(p.limit, PAGE * 2);
  assert.equal(filterCount(s.filters), 2);
});

test("dialog requests send cents, sign money in and out, and leave an empty category out", () => {
  const d = { accountId: "a", isoCurrency: "USD" };
  const out = entryRequest(
    { name: "Cafe", amount: "4.50", date: "2026-11-02", categoryId: "", direction: "out" },
    d,
    {}
  );
  assert.equal(out.body.categoryId, undefined);
  assert.equal(out.body.amountCents, 450);
  const inn = entryRequest({ name: "Pay", amount: "10", direction: "in" }, d, {
    today: "2026-11-02"
  });
  assert.equal(inn.body.amountCents, -1000);
  assert.match(entryRequest({ name: "", amount: "1" }, d, {}).problem, /payee/);
  const card = accountRequest(
    { name: "Card", accountType: "credit", opening: "-50" },
    { today: "2026-11-02" }
  );
  assert.equal(card.body.openingBalanceCents, 5000);
});
