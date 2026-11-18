/* global document, window, Element, HTMLInputElement, HTMLSelectElement, HTMLFormElement, FormData, setTimeout, clearTimeout */
import { moduleClient } from "./guest-bridge.mjs";
import { financeApi } from "./api.mjs";
import { defaultLedgerMonth, parseAmountToCents, shiftMonth, thisMonth } from "./format.mjs";
import { segmented } from "./html.mjs";
import { budgetView } from "./budget.mjs";
import { saveFailure } from "./budget-model.mjs";
import { accountsView } from "./accounts.mjs";
import { transactionsView } from "./transactions.mjs";
import { emptyFilters, requestParams } from "./transactions-model.mjs";
import { accountDialog, entryDialog, accountRequest, entryRequest } from "./dialogs.mjs";

const client = moduleClient();
const api = financeApi(client);
const root = document.getElementById("root");

const FLEX_POOL = "moss:flex-pool";
const TABS = [["budget", "Budget"], ["transactions", "Transactions"], ["accounts", "Accounts"]];
const fromHash = () => {
  const [tab, query = ""] = window.location.hash.slice(1).split("?");
  return { tab: TABS.some(([id]) => id === tab) ? tab : "budget", params: new URLSearchParams(query) };
};
const start = fromHash();

const state = {
  tab: start.tab,
  budget: { month: thisMonth(), status: null, error: false, drafts: {}, errors: {}, savingId: null, locked: false, message: "", stale: "", currency: "", busy: false, setupMessage: "" },
  tx: { month: defaultLedgerMonth(), view: "all", search: "", filters: { ...emptyFilters(), accountId: start.params.get("accountId") ?? "" }, filtersOpen: false, pages: 1, data: null, error: false, picker: null, message: "" },
  acct: { data: null, error: false, showClosed: false },
  context: null,
  dialog: null
};
const seq = { budget: 0, tx: 0, acct: 0 };

function saveFocus() {
  const el = document.activeElement;
  if (!(el instanceof Element) || !root.contains(el)) return null;
  const key = el.matches("[data-line]") ? `[data-assign="${el.dataset.assign}"][data-line="${el.dataset.line}"]` : el.matches("[data-search]") ? "[data-search]" : null;
  return key ? { key, start: el.selectionStart, end: el.selectionEnd } : null;
}

function render() {
  const focus = saveFocus();
  const tabs = segmented("Finance sections", TABS.map(([id, label]) => ({ act: "tab", data: ` data-tab="${id}"`, value: id, label })), state.tab);
  const body = state.tab === "budget" ? budgetView(state.budget) : state.tab === "transactions" ? transactionsView(state.tx) : accountsView(state.acct);
  const dialog = state.dialog ? (state.dialog.kind === "account" ? accountDialog(state.dialog, state.context) : entryDialog(state.dialog, state.context)) : "";
  root.innerHTML = `<div class="fnm-stack"><h1 class="jds-sr-only">Finance</h1><nav class="fnm-tabs" aria-label="Finance sections">${tabs}</nav>${body}</div>${dialog}`;
  if (focus) {
    const el = root.querySelector(focus.key);
    if (el instanceof HTMLInputElement) {
      el.focus();
      if (focus.start !== null) el.setSelectionRange(focus.start, focus.end);
    }
  }
  void client.resize(Math.ceil(document.documentElement.scrollHeight)).catch(() => {});
}

async function loadBudget() {
  const b = state.budget;
  const mine = ++seq.budget;
  b.status = null;
  b.error = false;
  render();
  try {
    const status = await api.budget(b.month);
    if (mine !== seq.budget) return;
    b.status = status;
  } catch {
    if (mine === seq.budget) b.error = true;
  }
  render();
}

async function loadTransactions() {
  const t = state.tx;
  const mine = ++seq.tx;
  t.error = false;
  try {
    const data = await api.transactions(requestParams(t));
    if (mine !== seq.tx) return;
    t.data = data;
  } catch {
    if (mine === seq.tx) t.error = true;
  }
  render();
}

async function loadAccounts() {
  const mine = ++seq.acct;
  state.acct.error = false;
  try {
    const data = await api.accounts();
    if (mine !== seq.acct) return;
    state.acct.data = data;
  } catch {
    if (mine === seq.acct) state.acct.error = true;
  }
  render();
}

const loaders = { budget: loadBudget, transactions: loadTransactions, accounts: loadAccounts };
const reload = () => loaders[state.tab]();

function goTab(tab, params = "") {
  state.tab = tab;
  window.history.replaceState(null, "", `#${tab}${params ? `?${params}` : ""}`);
  void reload();
}

async function saveAssign(lineId) {
  const b = state.budget;
  const raw = b.drafts[lineId];
  const cents = parseAmountToCents(raw ?? "");
  if (cents === null) {
    b.errors[lineId] = "Enter an amount like 250 or 250.50.";
    render();
    return false;
  }
  const status = b.status;
  const previous = status.state?.categories?.[lineId]?.assignedCents ?? 0;
  const common = { month: b.month, amountCents: cents, previousCents: previous, expectedRevision: status.revision, expectedFingerprint: status.fingerprint };
  b.savingId = lineId;
  b.message = "";
  render();
  try {
    if (lineId === FLEX_POOL) await api.assignFlex(common);
    else await api.apply({ ...common, categoryId: lineId });
    delete b.drafts[lineId];
    delete b.errors[lineId];
    b.savingId = null;
    const next = await api.budget(b.month);
    b.status = next;
    b.stale = "";
  } catch (error) {
    b.savingId = null;
    b.errors[lineId] = saveFailure(error);
    if (error?.code === "stale_budget" || error?.code === "stale_previous") {
      b.stale = "The budget changed since you opened it.";
      b.locked = false;
    }
  }
  render();
  return true;
}

function focusNext(input, step) {
  const fields = [...root.querySelectorAll(`input[data-assign="${input.dataset.assign}"]`)];
  for (let i = fields.indexOf(input) + step; i >= 0 && i < fields.length; i += step) {
    if (!fields[i].disabled) return fields[i].focus();
  }
}

async function setCurrency() {
  const b = state.budget;
  b.busy = true;
  b.setupMessage = "";
  render();
  try {
    await api.configure({ isoCurrency: b.currency, acknowledgeLegacy: (b.status?.legacyMonths ?? []).length > 0 });
    b.busy = false;
    await loadBudget();
  } catch {
    b.busy = false;
    b.setupMessage = "The currency choice could not be confirmed. Refresh to check the saved budget before trying again.";
    render();
  }
}

async function confirmRows(ids, categoryId, createRule) {
  const t = state.tx;
  const rows = t.data.transactions.filter((r) => ids.includes(r.id));
  t.message = "";
  try {
    await api.review({
      transactionIds: rows.map((r) => r.id),
      accountIds: rows.map((r) => r.accountId),
      months: rows.map(() => t.month),
      categoryIds: rows.map((r) => categoryId ?? r.categoryId),
      ...(createRule ? { createRule: true } : {})
    });
    t.picker = null;
  } catch (error) {
    t.message = error?.status === 409 ? "These rows changed. The list was refreshed." : "That could not be saved. Try again.";
  }
  await loadTransactions();
}

async function setCategory(id, categoryId) {
  const t = state.tx;
  const row = t.data.transactions.find((r) => r.id === id);
  if (!row) return;
  try {
    await api.setCategory({ month: t.month, transactionId: id, accountId: row.accountId, categoryId });
    t.message = "";
  } catch {
    t.message = "That category could not be saved. Try again.";
  }
  await loadTransactions();
}

async function ensureContext() {
  if (state.context) return;
  try {
    const c = await client.request("GET", "/finance/manual/context");
    state.context = c?.body ?? c;
    state.context.defaultCurrency = state.context.currencies?.[0];
  } catch {
    state.context = { currencies: ["USD"], categories: [], today: new Date().toISOString().slice(0, 10) };
  }
}

async function saveDialog() {
  const d = state.dialog;
  const form = root.querySelector("form[data-form]");
  if (!(form instanceof HTMLFormElement)) return;
  const values = Object.fromEntries(new FormData(form).entries());
  const built = d.kind === "account" ? accountRequest(values, state.context) : entryRequest(values, d, state.context);
  if (built.problem) {
    Object.assign(d, values, { error: built.problem });
    return render();
  }
  d.busy = true;
  Object.assign(d, values);
  render();
  try {
    await api.call("POST", d.kind === "account" ? "/finance/manual/accounts" : "/finance/manual/entries", built.body);
    state.dialog = null;
    state.tx.data = null;
    await loadAccounts();
  } catch (error) {
    d.busy = false;
    d.error = error?.detail || "That could not be saved. Try again.";
    render();
  }
}

let searchTimer = 0;

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-act], [data-scrim]") : null;
  if (!target) return;
  if (target.matches("[data-scrim]")) {
    if (event.target === target) { state.dialog = null; render(); }
    return;
  }
  const act = target.dataset.act;
  const b = state.budget;
  const t = state.tx;
  switch (act) {
    case "tab": return goTab(target.dataset.tab);
    case "refresh": return void reload();
    case "month-prev": case "month-next":
      if (Object.keys(b.drafts).length) { b.message = "Save or clear your typed amounts before changing months."; return render(); }
      b.month = shiftMonth(b.month, act === "month-next" ? 1 : -1);
      return void loadBudget();
    case "assign-save": return void saveAssign(target.dataset.line);
    case "discard-drafts": b.drafts = {}; b.errors = {}; b.stale = ""; b.message = ""; return render();
    case "set-currency": return void setCurrency();
    case "go-look": t.view = "look"; t.month = b.month; return goTab("transactions");
    case "go-overspent": {
      const row = root.querySelector('[data-overspent="true"]');
      if (row instanceof Element) row.scrollIntoView({ block: "center" });
      return;
    }
    case "go-accounts": return goTab("accounts");
    case "view": t.view = target.dataset.view; t.pages = 1; return void loadTransactions();
    case "tx-prev": case "tx-next": t.month = shiftMonth(t.month, act === "tx-next" ? 1 : -1); t.pages = 1; return void loadTransactions();
    case "toggle-filters": t.filtersOpen = !t.filtersOpen; return render();
    case "clear-filters": t.filters = emptyFilters(); t.pages = 1; return void loadTransactions();
    case "show-more": t.pages += 1; return void loadTransactions();
    case "confirm": return void confirmRows([target.dataset.tx]);
    case "confirm-all": return void confirmRows(t.data.transactions.filter((r) => r.reviewState === "needs_look" && !r.shared && r.categoryId).map((r) => r.id));
    case "pick": t.picker = { id: target.dataset.tx, categoryId: t.data.transactions.find((r) => r.id === target.dataset.tx)?.categoryId ?? "", always: false }; return render();
    case "picker-cancel": t.picker = null; return render();
    case "picker-confirm":
      if (!t.picker?.categoryId) { t.message = "Choose a category first."; return render(); }
      return void confirmRows([t.picker.id], t.picker.categoryId, t.picker.always);
    case "open-account": state.tx.filters = { ...emptyFilters(), accountId: target.dataset.account }; t.pages = 1; return goTab("transactions", `accountId=${encodeURIComponent(target.dataset.account)}`);
    case "toggle-closed": state.acct.showClosed = !state.acct.showClosed; return render();
    case "connect-bank": return void client.chat("Connect my bank account").catch(() => {});
    case "reconnect": return void client.chat(`Reconnect my ${target.dataset.bank} account`).catch(() => {});
    case "add-account": return void ensureContext().then(() => { state.dialog = { kind: "account" }; render(); });
    case "add-entry": case "go-add-entry": {
      const id = target.dataset.account;
      const account = (state.acct.data?.accounts ?? []).find((a) => a.accountId === id);
      if (!account) return goTab("accounts");
      return void ensureContext().then(() => { state.dialog = { kind: "entry", accountId: id, accountName: account.name, isoCurrency: account.isoCurrency }; render(); });
    }
    case "dialog-close": state.dialog = null; return render();
    case "dialog-save": return void saveDialog();
    default:
  }
});

root.addEventListener("input", (event) => {
  const el = event.target;
  if (el instanceof HTMLInputElement && el.matches("[data-line]")) {
    state.budget.drafts[el.dataset.line] = el.value;
    delete state.budget.errors[el.dataset.line];
    render();
  } else if (el instanceof HTMLInputElement && el.matches("[data-search]")) {
    state.tx.search = el.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.tx.pages = 1; void loadTransactions(); }, 300);
  } else if (el instanceof HTMLInputElement && el.matches("[data-picker-always]")) {
    state.tx.picker.always = el.checked;
  }
});

root.addEventListener("change", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLSelectElement)) return;
  if (el.matches("[data-currency]")) { state.budget.currency = el.value; return render(); }
  if (el.matches("[data-filter]")) { state.tx.filters[el.dataset.filter] = el.value; state.tx.pages = 1; return void loadTransactions(); }
  if (el.matches("[data-picker-category]")) { state.tx.picker.categoryId = el.value; return; }
  if (el.matches("[data-category-for]") && el.value) void setCategory(el.dataset.categoryFor, el.value);
});

root.addEventListener("keydown", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || !el.matches("[data-line]")) return;
  const id = el.dataset.line;
  if (event.key === "Escape") { delete state.budget.drafts[id]; delete state.budget.errors[id]; render(); }
  if (event.key === "Enter") {
    event.preventDefault();
    if (state.budget.drafts[id] === undefined) return focusNext(el, event.shiftKey ? -1 : 1);
    void saveAssign(id).then((ok) => {
      if (!ok) return;
      const next = root.querySelector(`input[data-assign="${el.dataset.assign}"][data-line="${id}"]`);
      if (next instanceof HTMLInputElement) focusNext(next, event.shiftKey ? -1 : 1);
    });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.dialog) { state.dialog = null; render(); }
});

render();
void reload();
