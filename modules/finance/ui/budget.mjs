// Budget screen markup. Everything here is a pure function of the screen state.
import { formatCents, monthLabel, shiftMonth } from "./format.mjs";
import {
  badge,
  button,
  emptyState,
  errorState,
  esc,
  loadingLine,
  masthead,
  note,
  sectionHead,
  statTile,
  stepper
} from "./html.mjs";
import {
  amountFieldText,
  buildGroups,
  groupAssigned,
  meterWidth,
  overspent
} from "./budget-model.mjs";

const money = formatCents;

const available = (cents, currency, labelled) =>
  cents < 0
    ? badge(`${money(-cents, currency)} over`, "red")
    : `<strong>${esc(money(cents, currency))}${labelled ? " left" : ""}</strong>`;

const carried = (line) =>
  line.carried === null
    ? `<div>${badge("Carry unavailable")}</div>`
    : line.carried > 0
      ? `<div>${badge(`${money(line.carried, line.currency)} carried over`)}</div>`
      : "";

const meter = (line) =>
  `<div class="jds-progress${line.available < 0 ? " jds-progress--amber" : ""}" aria-hidden="true"><div class="jds-progress__fill" style="width:${meterWidth(line)}%"></div></div>`;

function field(line, layout, s) {
  const draft = s.drafts[line.id];
  const locked = s.locked || line.archived || s.savingId === line.id;
  const error = s.errors[line.id];
  const value = draft ?? amountFieldText(line.assigned, line.currency);
  return `<div class="fnm-assign"><input class="jds-input jds-input--sm fnm-assign__input" aria-label="Assigned to ${esc(line.name)}"${error ? ' aria-invalid="true"' : ""} data-assign="${layout}" data-line="${esc(line.id)}" inputmode="decimal" enterkeyhint="next"${locked ? " disabled" : ""} value="${esc(value)}">${
    draft !== undefined
      ? button("Save", {
          act: "assign-save",
          extra: ` data-line="${esc(line.id)}" aria-label="Save assignment to ${esc(line.name)}"`,
          disabled: locked
        })
      : ""
  }${line.archived ? badge("Archived · history") : ""}${error ? `<p role="alert" class="jds-hint fnm-field-error">${esc(error)}</p>` : ""}</div>`;
}

const rowAttrs = (line) => ` data-overspent="${line.available < 0}"`;

function desktopGroup(group, head, s) {
  const rows = group.lines
    .map(
      (l) =>
        `<tr${rowAttrs(l)}><td><div class="fnm-block fnm-block--tight"><span>${esc(l.name)}</span>${carried(l)}</div></td><td class="jds-table__num">${field(l, "desktop", s)}</td><td class="jds-table__num"><div class="fnm-cell-stack"><span>${esc(money(l.spent, l.currency))}</span><div class="fnm-cell-meter">${meter(l)}</div></div></td><td class="jds-table__num">${available(l.available, l.currency)}</td></tr>`
    )
    .join("");
  return `<section class="fnm-block fnm-block--tight">${sectionHead(group.name, `${groupAssigned(group)} assigned`)}<table class="jds-table fnm-fixed"><colgroup><col class="fnm-col-name"><col><col><col></colgroup>${
    head
      ? '<thead><tr><th>Category</th><th class="jds-table__num">Assigned</th><th class="jds-table__num">Spent</th><th class="jds-table__num">Available</th></tr></thead>'
      : ""
  }<tbody>${rows}</tbody></table></section>`;
}

function phoneGroup(group, head, s) {
  const rows = group.lines
    .map(
      (l) =>
        `<tr${rowAttrs(l)}><td><div class="fnm-block fnm-block--tight"><div><span>${esc(l.name)}</span><div class="jds-table__sub">${esc(money(l.spent, l.currency))} spent</div></div>${meter(l)}${carried(l)}</div></td><td class="jds-table__num"><div class="fnm-block fnm-block--tight fnm-cell-end">${field(l, "phone", s)}${available(l.available, l.currency, true)}</div></td></tr>`
    )
    .join("");
  return `<section class="fnm-block fnm-block--tight">${sectionHead(group.name, `${groupAssigned(group)} assigned`)}<table class="jds-table fnm-fixed"><colgroup><col><col class="fnm-col-assign"></colgroup>${
    head ? '<thead><tr><th>Category</th><th class="jds-table__num">Assigned</th></tr></thead>' : ""
  }<tbody>${rows}</tbody></table></section>`;
}

function asOfLabel(iso) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso ?? "");
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "Sign-in expired";
  return `As of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) })}`;
}

function balances(status) {
  const rows = (status.accounts ?? [])
    .map((a) => {
      const excerpt = a.asOf ? asOfLabel(a.asOf) : "No balance recorded for this period";
      const amountText =
        a.balanceCents === null || a.balanceCents === undefined
          ? "No recorded balance"
          : money(a.balanceCents, a.isoCurrency || status.isoCurrency);
      const meta = a.stale
        ? `<div class="fnm-block fnm-block--tight fnm-end"><span>${esc(amountText)}</span><span class="jds-indicator jds-indicator--error"><span class="jds-indicator__dot"></span>${esc(asOfLabel(a.asOf))}</span></div>`
        : esc(amountText);
      return `<div class="jds-index__row"><div class="jds-index__title">${esc(a.name)}</div><div class="jds-index__excerpt">${esc(excerpt)}</div><div class="jds-index__meta">${meta}</div></div>`;
    })
    .join("");
  return `<div class="jds-index jds-index--facts">${rows}</div>`;
}

function needsYou(status, groups) {
  const over = overspent(groups);
  const tiles = [];
  if (status.needsLookCount > 0)
    tiles.push(
      statTile({ label: "Needs a look", value: String(status.needsLookCount), act: "go-look" })
    );
  if (over.length > 0)
    tiles.push(
      statTile({ label: "Overspent", value: String(over.length), act: "go-overspent", warn: true })
    );
  return tiles.length
    ? `<section class="fnm-block fnm-block--tight">${sectionHead("Needs you")}<div class="fnm-stat-pair">${tiles.join("")}</div></section>`
    : "";
}

function notes(status) {
  const out = [];
  if (status.readyUnavailable === "missing_history")
    out.push(
      note(
        "practical",
        "A budget account has no recorded balance for this month, so Ready to assign is unavailable."
      )
    );
  if (status.readyUnavailable === "future_month")
    out.push(note("practical", "Ready to assign shows in the current month."));
  if (status.futureReservedCents > 0)
    out.push(
      note(
        "plan",
        `${money(status.futureReservedCents, status.isoCurrency)} is reserved for future assignments.`
      )
    );
  const hints = [];
  if (status.pendingCount > 0) hints.push(`${status.pendingCount} pending not counted yet`);
  if (status.excludedAccountCount > 0)
    hints.push(`${status.excludedAccountCount} tracking or other-currency accounts left out`);
  if (hints.length) out.push(`<p class="jds-hint">${esc(hints.join(" · "))}</p>`);
  return out.join("");
}

function setup(status, s) {
  const options = (status.currencies ?? [])
    .map(
      (c) => `<option value="${esc(c)}"${s.currency === c ? " selected" : ""}>${esc(c)}</option>`
    )
    .join("");
  const legacy = (status.legacyMonths ?? []).length;
  return `<section class="fnm-block fnm-budget-setup" aria-label="Budget currency setup"><p class="jds-hint">You can't change the budget currency later.</p>${
    (status.accountCurrencies ?? []).length
      ? `<p>Account currencies: ${esc(status.accountCurrencies.join(", "))}</p>`
      : ""
  }<label class="fnm-block fnm-block--tight">Budget currency<select class="jds-select" aria-label="Budget currency" data-currency><option value="">Choose a currency</option>${options}</select></label>${
    legacy
      ? note(
          "pull",
          `You have assignments in ${legacy} ${legacy === 1 ? "month" : "months"} from before currency setup. Their amounts stay unchanged.`
        )
      : ""
  }${s.setupMessage ? `<p role="status">${esc(s.setupMessage)}</p>` : ""}<div class="fnm-inline">${button(s.busy ? "Saving…" : "Set currency", { act: "set-currency", variant: "primary", size: "md", disabled: !s.currency || s.busy })}${button("Refresh", { act: "refresh", size: "md" })}</div></section>`;
}

export function heroHtml(s) {
  const status = s.status;
  const setupMode = status?.setupRequired === true;
  const unavailable =
    !status || status.readyToAssignCents === null || status.readyToAssignCents === undefined;
  const title = setupMode
    ? "Choose a currency"
    : unavailable
      ? status?.readyUnavailable
        ? "Unavailable"
        : "$––.––"
      : money(status.readyToAssignCents, status.isoCurrency);
  return masthead({
    eyebrowText: setupMode ? "Your budget" : "Ready to assign",
    title: esc(title),
    aside: stepper({ label: monthLabel(s.month), prev: "month-prev", next: "month-next" })
  });
}

export function budgetView(s) {
  const status = s.status;
  if (s.error && !status)
    return errorState("Your budget didn't load.", button("Try again", { act: "refresh" }));
  if (!status) return `${heroHtml(s)}${loadingLine("Loading budget")}`;
  if (status.setupRequired) return `${heroHtml(s)}${setup(status, s)}`;
  if (status.cardLedgerReviewRequired)
    return `${heroHtml(s)}${note("practical", "Card payments need a review in the assistant before this month can be budgeted.")}`;
  if (status.hasBank === false)
    return `${heroHtml(s)}${emptyState("Give your budget an account", "Add a manual account or connect a bank to start budgeting.", `${button("Add manual account", { act: "go-accounts", variant: "primary", size: "md" })}${button("Connect a bank", { act: "go-accounts", size: "md" })}`)}`;
  const groups = buildGroups(status);
  const stale = s.stale
    ? `<div class="jds-note jds-note--practical" role="status">${esc(s.stale)} ${button("Check saved records", { act: "refresh" })} ${button("Discard typed amounts", { act: "discard-drafts" })}</div>`
    : "";
  const dirty = Object.keys(s.drafts).length > 0;
  const body = (render) => groups.map((g, i) => render(g, i === 0, s)).join("");
  const empty =
    groups.length === 0
      ? emptyState("No categories yet", "Categories appear here once the budget is set up.")
      : "";
  const rail = `<aside class="fnm-rail">${needsYou(status, groups)}<section class="fnm-block fnm-block--tight">${sectionHead("Balances")}${balances(status)}</section></aside>`;
  const phoneTop = needsYou(status, groups);
  return `<div class="fnm-hero">${heroHtml(s)}</div>${stale}${notes(status)}${s.message ? `<p role="status" class="jds-hint">${esc(s.message)}</p>` : ""}<div class="fnm-page"><div class="fnm-block"><div class="fnm-phone-only">${phoneTop}</div><div class="fnm-block fnm-desktop-only" data-lines="desktop">${body(desktopGroup)}</div><div class="fnm-block fnm-phone-only" data-lines="phone">${body(phoneGroup)}</div>${empty}${dirty ? `<p class="jds-hint">${button("Discard typed amounts", { act: "discard-drafts" })}</p>` : ""}</div><div class="fnm-desktop-only">${rail}</div></div><details class="fnm-phone-only"><summary>Budget accounts</summary>${balances(status)}</details>`;
}

export { shiftMonth };
