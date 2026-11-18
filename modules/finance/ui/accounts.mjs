// Accounts screen markup.
import { formatCents } from "./format.mjs";
import { buildAccountsView } from "./accounts-model.mjs";
import {
  button,
  emptyState,
  errorState,
  esc,
  loadingLine,
  masthead,
  sectionHead
} from "./html.mjs";

const amount = (cents, currency) => (cents === null ? "Unavailable" : formatCents(cents, currency));
const totalsLabel = (totals) => totals.map((t) => amount(t.cents, t.currency)).join(" · ");

const bankStatus = (bank) =>
  `<span class="fnm-bank-status-row"><span class="jds-indicator jds-indicator--error"><span class="jds-indicator__dot"></span>${esc(`${bank.name} · ${bank.statusLabel}`)}</span>${
    bank.reconnect
      ? button("Reconnect", {
          act: "reconnect",
          extra: ` data-bank="${esc(bank.name)}" aria-label="Reconnect ${esc(bank.name)}"`
        })
      : ""
  }</span>`;

function groupTable(group, multi) {
  const rows = group.rows
    .map(
      (r) =>
        `<tr><td><button type="button" class="jds-table__rowlink" data-act="open-account" data-account="${esc(r.accountId)}" aria-label="View transactions for ${esc(r.name)}">${esc(r.name)}</button>${r.mask ? `<span class="jds-hint">${esc(` · xxx${r.mask}`)}</span>` : ""}<div class="jds-table__sub">${esc(r.source)}</div></td><td class="jds-table__num">${esc(formatCents(r.balanceCents, r.isoCurrency))}${multi ? `<div class="jds-table__sub">${esc(r.isoCurrency)}</div>` : ""}</td><td>${
          r.manual
            ? button("Add transaction", {
                act: "add-entry",
                variant: "quiet",
                extra: ` data-account="${esc(r.accountId)}" aria-label="Add transaction to ${esc(r.name)}"`
              })
            : ""
        }</td></tr>`
    )
    .join("");
  return `<section aria-label="${esc(group.title)}" class="fnm-block fnm-block--tight">${sectionHead(group.title, totalsLabel(group.totals))}<table class="jds-table fnm-fixed"><colgroup><col><col class="fnm-col-amount"><col class="fnm-col-actions"></colgroup><thead><tr><th scope="col" class="jds-sr-only">Account</th><th scope="col" class="jds-sr-only">Balance</th><th scope="col" class="jds-sr-only">Actions</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function accountsView(s, now = new Date()) {
  if (s.error && !s.data)
    return errorState("Your accounts didn't load.", button("Try again", { act: "refresh" }));
  if (!s.data) return loadingLine("Loading accounts");
  const own = s.data.accounts ?? [];
  const closed = own.filter((a) => a.source === "manual" && a.archivedAt);
  const active = own.filter((a) => !closed.includes(a));
  const addButtons = `${button("Add manual account", { act: "add-account", variant: "primary" })}${button("Connect a bank", { act: "connect-bank" })}`;
  if (own.length === 0)
    return emptyState(
      "Give your accounts a home",
      "Add a manual account or connect a bank.",
      addButtons
    );
  const view = buildAccountsView(active, s.data.banks ?? [], now);
  const multi = view.net.length > 1;
  const worth = view.net
    .map(
      (n) =>
        `<div class="fnm-account-totals-item">${masthead({
          eyebrowText: multi ? `Net worth · ${n.currency}` : "Net worth",
          title: esc(amount(n.cents, n.currency)),
          aside: `<dl class="jds-masthead__figures" aria-label="Assets and debts"><div class="jds-masthead__figure"><dt class="jds-masthead__figure-label">Assets</dt><dd class="jds-masthead__figure-value">${esc(amount(n.assets, n.currency))}</dd></div><div class="jds-masthead__figure"><dt class="jds-masthead__figure-label">Debts</dt><dd class="jds-masthead__figure-value">${esc(amount(n.debts, n.currency))}</dd></div></dl>`
        })}</div>`
    )
    .join("");
  const broken = view.banks
    .filter((b) => b.status === "error")
    .map(
      (b) =>
        `<div class="fnm-block fnm-block--tight">${bankStatus(b)}${b.message ? `<p class="jds-hint">${esc(b.message)}</p>` : ""}</div>`
    )
    .join("");
  const closedBlock = closed.length
    ? `<section aria-label="Closed manual accounts" class="fnm-block fnm-block--tight"><button type="button" class="jds-btn jds-btn--link fnm-disclosure-head" data-act="toggle-closed" aria-expanded="${s.showClosed === true}">Closed accounts (${closed.length})<span class="fnm-disclosure-marker" aria-hidden="true"></span></button>${
        s.showClosed
          ? `<div class="jds-index jds-index--compact">${closed.map((a) => `<div class="jds-index__row"><div class="jds-index__title">${esc(a.name)}</div></div>`).join("")}</div>`
          : ""
      }</section>`
    : "";
  return `<div class="fnm-stack"><div class="fnm-account-actions">${button("Add account", { act: "add-account", variant: "secondary", size: "md" })}${button("Connect a bank", { act: "connect-bank", size: "md" })}</div><div class="fnm-account-totals" aria-label="Account totals by currency">${worth}</div>${broken}${view.groups.map((g) => groupTable(g, multi)).join("")}${closedBlock}</div>`;
}
