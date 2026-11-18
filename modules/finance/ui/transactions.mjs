// Transactions screen markup.
import { formatCents, monthLabel, shortDayLabel, shortMonthLabel, shiftMonth } from "./format.mjs";
import { badge, button, emptyState, errorState, esc, icons, loadingLine, segmented, stepper } from "./html.mjs";
import { MAX_PAGES, PAGE, accountName, categoryName, filterCount, isMoneyIn, needsLook, splitUnbalanced } from "./transactions-model.mjs";

const amountText = (row) => {
  const text = formatCents(Math.abs(row.amountCents), row.isoCurrency);
  return isMoneyIn(row) ? `<strong>+${esc(text)}</strong>` : esc(text);
};

function badges(row) {
  const out = [];
  if (row.pending) out.push(badge("Pending", "steel"));
  if (row.source === "manual" && !row.pending && !row.reconciledAt && row.cleared === false) out.push(badge("Uncleared", "steel"));
  if (row.shared) out.push(badge("Household · read only", "steel"));
  if (row.possibleDuplicate) out.push(badge("Possible duplicate", "amber"));
  if (splitUnbalanced(row)) out.push(badge("Check split total", "amber"));
  if (row.transferId) out.push(badge("Linked transfer"));
  return out.length ? `<div class="fnm-chips fnm-row-badges">${out.join("")}</div>` : "";
}

const options = (list, value, blank) =>
  `<option value="">${esc(blank)}</option>${list.map((c) => `<option value="${esc(c.id)}"${c.id === value ? " selected" : ""}>${esc(c.name)}</option>`).join("")}`;

function categoryCell(row, d, s) {
  const cats = d.categories ?? [];
  if (row.shared) return `<span>${esc(categoryName(cats, row.categoryId) || "Uncategorized")}</span>`;
  if (needsLook(row)) {
    if (s.picker?.id === row.id) {
      return `<div class="fnm-block fnm-block--tight"><select class="jds-select" aria-label="Category for ${esc(row.name)}" data-picker-category>${options(cats, s.picker.categoryId, "Choose category")}</select><label class="fnm-inline"><input type="checkbox" data-picker-always${s.picker.always ? " checked" : ""}> Always for this merchant</label><div class="fnm-inline">${button("Confirm", { act: "picker-confirm", variant: "primary", extra: ` data-tx="${esc(row.id)}"` })}${button("Cancel", { act: "picker-cancel" })}</div></div>`;
    }
    const name = categoryName(cats, row.categoryId);
    return `<div class="fnm-look"><span>${esc(name || "Uncategorized")}</span><span class="fnm-inline">${
      name ? button("Confirm", { act: "confirm", variant: "primary", extra: ` data-tx="${esc(row.id)}" aria-label="Confirm ${esc(row.name)}"` }) : ""
    }${button(name ? "Change" : "Choose category", { act: "pick", extra: ` data-tx="${esc(row.id)}" aria-label="${name ? "Change" : "Choose"} category for ${esc(row.name)}"` })}</span></div>`;
  }
  return `<select class="jds-select jds-select--quiet" aria-label="Category for ${esc(row.name)}" data-category-for="${esc(row.id)}">${options(cats, row.categoryId, "Uncategorized")}</select>`;
}

const payee = (row) => `<span class="fnm-txline__name">${esc(row.merchant || row.name)}</span>${badges(row)}`;

function table(d, s) {
  const rows = d.transactions
    .map(
      (r) => `<tr><td>${esc(shortDayLabel(r.date))}</td><td>${payee(r)}</td><td>${categoryCell(r, d, s)}</td><td>${esc(accountName(d.accounts, r.accountId))}</td><td class="jds-table__num fnm-amount">${amountText(r)}</td></tr>`
    )
    .join("");
  return `<table class="jds-table fnm-fixed"><colgroup><col class="fnm-col-date"><col class="fnm-col-payee"><col class="fnm-col-category"><col><col class="fnm-col-amount"></colgroup><thead><tr><th>Date</th><th>Payee</th><th>Category</th><th>Account</th><th class="jds-table__num">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function phoneRows(d, s) {
  return `<div class="fnm-block fnm-block--tight">${d.transactions
    .map(
      (r) => `<div class="fnm-txline"><span class="fnm-txline__name">${esc(r.merchant || r.name)}<span class="jds-hint"> ${esc(shortDayLabel(r.date))} · ${esc(accountName(d.accounts, r.accountId))}</span></span><span class="fnm-txline__amount fnm-amount">${amountText(r)}</span><div class="fnm-txline__body">${badges(r)}${categoryCell(r, d, s)}</div></div>`
    )
    .join("")}</div>`;
}

function filterPanel(d, s) {
  const f = s.filters;
  const sel = (key, label, opts, blank) =>
    `<label>${esc(label)}<select class="jds-select" data-filter="${key}"><option value="">${esc(blank)}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${f[key] === v ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
  return `<div class="fnm-register-filters" role="group" aria-label="Filters">${sel("accountId", "Account", (d.accounts ?? []).map((a) => [a.accountId, a.name]), "All accounts")}${sel("categoryId", "Category", (d.categories ?? []).map((c) => [c.id, c.name]), "All categories")}${sel("postingState", "Status", [["pending", "Pending"], ["posted", "Posted"]], "Any status")}${sel("direction", "Direction", [["inflow", "Money in"], ["outflow", "Money out"]], "Any direction")}${sel("ledgerState", "Manual ledger status", [["uncleared", "Uncleared"], ["cleared", "Cleared"], ["reconciled", "Reconciled"]], "Any")}${sel("check", "Check", [["uncategorized", "Uncategorized"], ["duplicates", "Possible duplicates"]], "None")}${button("Clear filters", { act: "clear-filters", variant: "quiet" })}</div>`;
}

export function toolbar(s, d) {
  const n = filterCount(s.filters);
  const look = d?.needsLookCount ?? 0;
  return `<div class="fnm-spread">${segmented("Show", [{ act: "view", data: ' data-view="all"', value: "all", label: "All" }, { act: "view", data: ' data-view="look"', value: "look", label: `Needs a look (${look})` }], s.view)}${stepper({ label: shortMonthLabel(s.month), prev: "tx-prev", next: "tx-next", prevText: "‹ " + shortMonthLabel(shiftMonth(s.month, -1)), nextText: shortMonthLabel(shiftMonth(s.month, 1)) + " ›" })}<input class="jds-input jds-input--sm fnm-search" type="search" aria-label="Search payees or notes" placeholder="Search payees or notes" data-search value="${esc(s.search)}">${button(n ? `Filters · ${n}` : "Filters", { act: "toggle-filters", extra: ` aria-expanded="${s.filtersOpen === true}"` })}</div>${s.filtersOpen && d ? filterPanel(d, s) : ""}`;
}

export function transactionsView(s) {
  const d = s.data;
  const head = toolbar(s, d);
  if (s.error && !d)
    return `${head}${errorState("We couldn't load your transactions. Your filters are kept; check your connection or try again.", button("Retry register", { act: "refresh" }))}`;
  if (!d) return `${head}${loadingLine("Loading transactions")}`;
  const filtered = filterCount(s.filters) > 0 || s.search.trim() !== "";
  let body;
  if (d.transactions.length === 0) {
    body = s.view === "look" && !filtered
      ? emptyState("Nothing needs a look", "No transactions in this view need review.")
      : filtered || s.view === "look"
        ? emptyState("No matches", "No transaction in this month matches.")
        : emptyState("No transactions this month", "", `${button("Add transaction", { act: "go-add-entry", variant: "primary" })}`);
  } else {
    const looks = d.transactions.filter((r) => needsLook(r) && r.categoryId).length;
    const confirmAll = looks > 1 && s.view === "look" ? `<div>${button(`Confirm all ${looks}`, { act: "confirm-all", variant: "primary" })}</div>` : "";
    const more = d.totalCount > d.transactions.length && s.pages < MAX_PAGES ? button("Show more", { act: "show-more" }) : "";
    body = `${confirmAll}<div class="fnm-desktop-only">${table(d, s)}</div><div class="fnm-phone-only">${phoneRows(d, s)}</div><div class="fnm-spread"><span class="jds-hint">${d.transactions.length} of ${d.totalCount} transactions</span>${more}</div>`;
  }
  return `${head}${s.message ? `<p role="alert" class="jds-hint">${esc(s.message)}</p>` : ""}<div class="fnm-block fnm-block--tight">${body}</div>`;
}

export { PAGE, monthLabel, icons };
