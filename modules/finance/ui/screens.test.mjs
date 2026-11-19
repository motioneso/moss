import assert from "node:assert/strict";
import test from "node:test";
import { billTotals, monthWindow, weeksOf, stateLabel, quietState } from "./upcoming-model.mjs";
import { defaultBarMonth, mergeSpending, ranked, trendPath } from "./reports-model.mjs";
import { tierLabel, weekWindow } from "./settings-model.mjs";
import { startView } from "./start.mjs";
import { upcomingView } from "./upcoming.mjs";
import { reportsView } from "./reports.mjs";

const bill = (over) => ({ planId: "p", name: "Rent", dueDate: "2026-11-03", plannedDate: "2026-11-03", expectedCents: 1000, state: "projected", accountId: "a", categoryId: "c", ...over });

test("a month window ends on its last day", () => {
  assert.deepEqual(monthWindow("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
});

test("bill totals skip skipped bills and count a posted bill at its real amount", () => {
  const t = billTotals([bill({}), bill({ state: "posted", actualCents: 900 }), bill({ state: "skipped" })]);
  assert.deepEqual(t, { due: 1900, paid: 900, toGo: 1000 });
});

test("bills group into Monday to Sunday weeks", () => {
  const weeks = weeksOf([bill({ plannedDate: "2026-11-01" }), bill({ plannedDate: "2026-11-02" }), bill({ plannedDate: "2026-11-09" })]);
  assert.equal(weeks.length, 3);
  assert.equal(weeks[0].start, "2026-10-26");
  assert.equal(weeks[1].start, "2026-11-02");
});

test("a bill past its date is badged and one on time is quiet", () => {
  const view = { today: "2026-11-10", isoCurrency: "USD" };
  assert.equal(stateLabel(bill({ plannedDate: "2026-11-03" }), view), "Past due · projected");
  assert.equal(quietState(bill({ plannedDate: "2026-11-12" }), view), true);
});

test("shared months add to the person's own", () => {
  const m = (n) => ({ month: "2026-11", byCategory: { food: n }, byPayee: { Shop: n }, cashFlow: { incomeCents: 0, outflowCents: n, netCents: -n } });
  const out = mergeSpending(["2026-11"], [m(100)], [{ months: [m(50)] }]);
  assert.equal(out[0].byCategory.food, 150);
  assert.equal(out[0].cashFlow.outflowCents, 150);
  assert.equal(defaultBarMonth(["2026-10", "2026-11"]), "2026-10");
  assert.deepEqual(ranked({ a: 1, b: 5, c: 0 }), [["b", 5], ["a", 1]]);
  assert.match(trendPath([{ totalCents: 1 }, { totalCents: 5 }], 100, 50), /^M.* L/);
});

test("settings labels and window", () => {
  assert.equal(tierLabel("ask_each_time"), "Asks you each time");
  assert.equal(tierLabel(null), "Unavailable");
  assert.ok(weekWindow(new Date("2026-11-18T00:00:00Z")).from < "2026-11-12");
});

test("Start needs no bank keys and offers a manual account", () => {
  const html = startView({ data: { keysConfigured: false, hasBank: false, hasManualAccount: false } });
  assert.match(html, /No bank keys are needed/);
  assert.match(html, /Add a manual account/);
  assert.match(html, /Waiting on your admin/);
  assert.match(startView({ data: null, error: true }), /Start didn.+t load/);
});

test("Upcoming and Reports show loading, empty and broken states", () => {
  const base = { month: "2026-11", data: null, suggestions: [], error: false, message: "", busy: false, blocked: false, dialog: null };
  assert.match(upcomingView(base), /Loading bills/);
  assert.match(upcomingView({ ...base, error: true }), /Your bills didn.+t load/);
  assert.match(upcomingView({ ...base, data: { setupRequired: true } }), /Choose a budget currency/);
  const empty = { today: "2026-11-10", isoCurrency: "USD", plans: [], occurrences: [], accounts: [], categories: [], transactions: [] };
  assert.match(upcomingView({ ...base, data: empty }), /No bills yet/);
  const r = { months: 6, currency: "", barMonth: "", spend: null, net: null, spendError: false, netError: false, open: {}, historyPage: 0, detail: null };
  assert.match(reportsView(r), /Loading reports/);
  assert.match(reportsView({ ...r, spendError: true, netError: true }), /Spending didn.+t load/);
  const none = { window: ["2026-11"], own: [], shared: [], categories: [], currencies: [], currency: null, currencySelectionRequired: false };
  assert.match(reportsView({ ...r, spend: none, net: { points: [] } }), /Nothing to report yet/);
});
