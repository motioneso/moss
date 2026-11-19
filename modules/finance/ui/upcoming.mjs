// The Upcoming screen: the month's bills, suggestions and saved bill plans.
import {
  esc,
  button,
  badge,
  sectionHead,
  emptyState,
  loadingLine,
  errorState,
  stepper,
  note
} from "./html.mjs";
import { formatCents, monthLabel, shortDayLabel } from "./format.mjs";
import {
  accountName,
  billTotals,
  cadenceLabel,
  categoryName,
  occurrenceDate,
  occurrenceKey,
  quietState,
  stateLabel,
  weekdayDayLabel,
  weeksOf
} from "./upcoming-model.mjs";
import { billDialog } from "./bill-dialogs.mjs";

function actions(o, view, busy) {
  const target = `${o.name}, ${shortDayLabel(occurrenceDate(o))}`;
  const key = ` data-key="${esc(occurrenceKey(o))}"`;
  const one = (label, act) =>
    `<button type="button" class="jds-btn jds-btn--secondary jds-btn--sm" data-act="${act}"${key} aria-label="${esc(label)}, ${esc(target)}"${busy ? " disabled" : ""}>${label}</button>`;
  const parts =
    o.state === "projected"
      ? [one("Match posted", "bill-match"), one("Skip occurrence", "bill-skip")]
      : [one("Undo review", "bill-undo")];
  if (o.canRecordEntry) parts.push(one("Record bill entry", "bill-record"));
  if (o.canAdjust) parts.push(one("Change this occurrence", "bill-adjust"));
  if (o.canAdjust && o.adjusted) parts.push(one("Reset one-off change", "bill-reset"));
  return `<div class="fnm-chips fnm-occ__actions">${parts.join("")}</div>`;
}

function row(o, view, busy) {
  const date = occurrenceDate(o);
  const bits = [weekdayDayLabel(date)];
  if (o.adjusted) bits.push(`one-off change from ${shortDayLabel(o.dueDate)}`);
  bits.push(accountName(view, o.accountId), categoryName(view, o.categoryId));
  const tone = o.state === "posted" ? "success" : o.state === "projected" ? "neutral" : "warning";
  return `<li class="fnm-occ"><div class="fnm-row"><div class="fnm-txmain"><strong>${esc(o.name)}</strong><span class="jds-hint">${esc(bits.join(" · "))}</span></div>${quietState(o, view) ? "" : badge(stateLabel(o, view), tone)}<span class="fnm-money">${formatCents(o.expectedCents, view.isoCurrency)} expected</span></div>${actions(o, view, busy)}</li>`;
}

function planRow(p, view, busy) {
  const ends = p.endDate
    ? p.endDate < view.today
      ? `stopped after ${shortDayLabel(p.endDate)}`
      : `stops ${shortDayLabel(p.endDate)}`
    : "";
  const bits = [
    accountName(view, p.accountId),
    `${cadenceLabel(p.cadence)} from ${shortDayLabel(p.anchorDate)}`
  ];
  if (ends) bits.push(ends);
  const live = !p.endDate || p.endDate >= view.today;
  const stop =
    live && p.cadence !== "once"
      ? button(p.endDate ? "Stop sooner" : "Stop future bills", {
          act: "bill-stop",
          extra: ` data-plan="${esc(p.id)}"${busy ? " disabled" : ""}`
        })
      : "";
  return `<li class="fnm-row"><div class="fnm-txmain"><strong>${esc(p.name)}</strong><span class="jds-hint">${esc(bits.join(" · "))}</span></div><span class="fnm-money">${formatCents(p.amountCents, view.isoCurrency)}</span>${stop}</li>`;
}

function suggestionRow(s, view, busy) {
  const extra = ` data-sug="${esc(s.payeeKey)}|${esc(s.accountId)}|${esc(s.cadence)}|${s.amountCents}"${busy ? " disabled" : ""}`;
  return `<li class="fnm-row"><div class="fnm-txmain"><strong>${esc(s.name)}</strong><span class="jds-hint">${esc(`${cadenceLabel(s.cadence)} · last ${shortDayLabel(s.lastDate)} · next ${shortDayLabel(s.nextDate)} · ${s.accountName ?? ""}`)}</span></div><span class="fnm-money">${formatCents(s.amountCents, view.isoCurrency)}</span>${button("Add as a bill", { act: "sug-add", extra })}${button("Dismiss", { act: "sug-dismiss", variant: "quiet", extra })}</li>`;
}

export function upcomingView(s) {
  const head = `<div class="fnm-end">${stepper({ label: monthLabel(s.month), prev: "bill-prev", next: "bill-next" })}</div>`;
  const message = s.message ? note("info", s.message) : "";
  if (s.error) {
    return `${head}${errorState("Your bills didn't load.", button("Try again", { act: "bill-reload" }))}`;
  }
  const v = s.data;
  if (!v) return `${head}${loadingLine("Loading bills")}`;
  if (v.setupRequired) {
    return `${head}${emptyState("Choose a budget currency", "Bills follow the currency your budget uses.", button("Open Budget", { act: "tab", variant: "primary", extra: ' data-tab="budget"' }))}`;
  }
  const busy = s.busy;
  const addBtn = button("Add a bill", { act: "bill-add", variant: "primary", disabled: busy });
  const refresh = s.blocked ? button("Check saved bills", { act: "bill-reload" }) : "";
  const bar = `<div class="fnm-chips">${addBtn}${refresh}</div>`;
  const totals = billTotals(v.occurrences);
  const money = (c) => formatCents(c, v.isoCurrency);
  const weeks = weeksOf(v.occurrences);
  const list = weeks.length
    ? weeks
        .map(
          (w) =>
            `<section class="fnm-week"><h3 class="jds-eyebrow">${esc(w.label)}</h3><ul class="fnm-feed">${w.items.map((o) => row(o, v, busy)).join("")}</ul></section>`
        )
        .join("")
    : `<p class="jds-hint">Nothing due in ${esc(monthLabel(s.month))}.</p>`;
  const bills =
    v.plans.length === 0 && v.occurrences.length === 0
      ? emptyState("No bills yet", "Add a bill and Moss shows when it is due.", addBtn)
      : `${sectionHead("Bills due", `${money(totals.due)} due · ${money(totals.paid)} paid · ${money(totals.toGo)} to go`)}<div class="fnm-weeks">${list}</div>`;
  const sug = s.suggestions?.length
    ? `${sectionHead("Suggested bills")}<ul class="fnm-feed">${s.suggestions.map((x) => suggestionRow(x, v, busy)).join("")}</ul>`
    : "";
  const plans = v.plans.length
    ? `${sectionHead("Your bill plans")}<ul class="fnm-feed">${v.plans.map((p) => planRow(p, v, busy)).join("")}</ul>`
    : "";
  return `${head}${message}${bar}${bills}${sug}${plans}${s.dialog ? billDialog(s.dialog, v) : ""}`;
}
