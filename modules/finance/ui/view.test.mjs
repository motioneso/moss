import assert from "node:assert/strict";
import test from "node:test";
import { budgetView } from "./budget.mjs";
import { accountsView } from "./accounts.mjs";
import { transactionsView } from "./transactions.mjs";
import { emptyFilters } from "./transactions-model.mjs";
import { financeApi } from "./api.mjs";

const NOW = new Date("2026-11-18T12:00:00Z");

test("the budget shows loading, error, setup and empty states", () => {
  assert.match(budgetView({ month: "2026-11", drafts: {}, errors: {} }), /Loading budget/);
  assert.match(budgetView({ month: "2026-11", drafts: {}, errors: {}, error: new Error("x") }), /load\./);
  assert.match(budgetView({ month: "2026-11", drafts: {}, errors: {}, status: { setupRequired: true, currencies: ["USD"], legacyMonths: 0 } }), /Set currency/);
  assert.match(budgetView({ month: "2026-11", drafts: {}, errors: {}, status: { hasBank: false, readyToAssignCents: 0, isoCurrency: "USD" } }), /Give your budget an account/);
});

test("a budget with data shows ready to assign, the table and a phone list", () => {
  const status = {
    hasBank: true, isoCurrency: "USD", readyToAssignCents: 25000, accounts: [], pendingCount: 0, needsLookCount: 0,
    state: { categories: { rent: { assignedCents: 100000, activityCents: -90000, availableCents: 10000 } } },
    categories: [{ id: "rent", name: "Rent", tableGroup: "Fixed" }]
  };
  const html = budgetView({ month: "2026-11", drafts: {}, errors: {}, status });
  assert.match(html, /Ready to assign/);
  assert.match(html, /\$250\.00/);
  assert.match(html, /Rent/);
  assert.match(html, /data-lines="desktop"/);
  assert.match(html, /data-lines="phone"/);
});

test("accounts show loading, error and empty states", () => {
  assert.match(accountsView({}, NOW), /Loading accounts/);
  assert.match(accountsView({ error: new Error("x") }, NOW), /load\./);
  assert.match(accountsView({ data: { accounts: [], banks: [] } }, NOW), /Give your accounts a home/);
});

test("a bank that cannot sync shows its status, its message and a Reconnect button", () => {
  const data = {
    accounts: [{ accountId: "a", name: "Checking", type: "depository", balanceCents: 5000, isoCurrency: "USD", source: "plaid", itemId: "i1" }],
    banks: [{ itemId: "i1", institutionName: "First Bank", status: "reauth-required", lastSyncAt: "2026-11-10T00:00:00Z", message: "Sign in again to keep this bank up to date." }]
  };
  const html = accountsView({ data }, NOW);
  assert.match(html, /First Bank · Sign-in expired/);
  assert.match(html, /Sign in again to keep this bank up to date\./);
  assert.match(html, /data-act="reconnect"/);
  assert.match(html, /aria-label="Reconnect First Bank"/);
  assert.match(html, /As of November (9|10)/);
});

test("a bank with a plain connection problem has no Reconnect button", () => {
  const data = {
    accounts: [{ accountId: "a", name: "Checking", type: "depository", balanceCents: 5000, isoCurrency: "USD", source: "plaid", itemId: "i1" }],
    banks: [{ itemId: "i1", institutionName: "First Bank", status: "error", lastSyncAt: null, message: null }]
  };
  const html = accountsView({ data }, NOW);
  assert.match(html, /Connection problem/);
  assert.doesNotMatch(html, /data-act="reconnect"/);
});

const base = { month: "2026-11", search: "", view: "all", pages: 1, filters: emptyFilters(), categories: [], accounts: [] };

test("transactions show loading, error and empty states", () => {
  assert.match(transactionsView({ ...base }), /Loading transactions/);
  assert.match(transactionsView({ ...base, error: new Error("x") }), /Retry register/);
  const empty = { transactions: [], totalCount: 0, needsLookCount: 0, categories: [], accounts: [] };
  assert.match(transactionsView({ ...base, data: empty }), /No transactions this month/);
  assert.match(transactionsView({ ...base, search: "zzz", data: empty }), /No matches/);
  assert.match(transactionsView({ ...base, view: "look", data: empty }), /Nothing needs a look/);
});

test("transactions list rows with a count and Show more when the month has more", () => {
  const row = (i) => ({ id: `t${i}`, accountId: "a", date: "2026-11-02", name: `Shop ${i}`, amountCents: 1000 + i, isoCurrency: "USD", pending: false, categoryId: null, reviewState: "confirmed" });
  const data = { transactions: [row(1), row(2)], totalCount: 5, needsLookCount: 0, categories: [], accounts: [{ accountId: "a", name: "Checking" }] };
  const html = transactionsView({ ...base, data });
  assert.match(html, /Shop 1/);
  assert.match(html, /2 of 5 transactions/);
  assert.match(html, /Show more/);
});

test("the api sends the month as a query value and reads refusals as errors", async () => {
  const calls = [];
  const client = { request: async (method, path, body) => { calls.push([method, path, body]); return { status: 409, body: { status: "error", code: "stale_budget", message: "changed" } }; } };
  const api = financeApi(client);
  await assert.rejects(api.budget("2026-11"), (e) => e.code === "stale_budget" || e.status === 409);
  assert.equal(calls[0][0], "GET");
  assert.match(calls[0][1], /^\/finance\/budget\/status\?month=2026-11/);
});
