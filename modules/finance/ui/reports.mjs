// The Reports screen: net worth, spending by category and payee, and monthly cash flow.
import { esc, button, sectionHead, emptyState, loadingLine, errorState, note, dialogHtml } from "./html.mjs";
import { formatCents, monthLabel, shortMonthLabel, shortDayLabel } from "./format.mjs";
import { defaultBarMonth, hasActivity, mergeSpending, ranked, trendPath } from "./reports-model.mjs";

const PERIODS = [3, 6, 12, 24];
const PAGE = 50;

const select = (name, options, value, label) =>
  `<label class="jds-field"><span class="jds-sr-only">${esc(label)}</span><select class="jds-select" data-rpt="${name}" aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;

function disclosure(id, title, open, inner) {
  return `<div class="fnm-disclosure"><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm fnm-disclosure-head" data-act="rpt-toggle" data-id="${id}" aria-expanded="${open}"><span class="fnm-disclosure-marker" aria-hidden="true"></span>${esc(title)}</button>${open ? inner : ""}</div>`;
}

function trend(points, label) {
  const w = 600;
  const h = 128;
  return `<svg class="fnm-report-trend" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><path d="${trendPath(points, w, h)}" fill="none" stroke="var(--accent-fg)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function netWorth(r, iso) {
  const n = r.net;
  if (r.netError) return errorState("Net worth didn't load.", button("Try again", { act: "rpt-reload" }));
  if (!n) return loadingLine("Loading net worth");
  if (n.unavailableReason) return `${sectionHead("Net worth")}${note("warning", "Net worth needs review. A saved balance history does not add up.")}`;
  if (!n.points?.length) return `${sectionHead("Net worth")}${emptyState("No balance history in this period", "Add an opening balance or connect a bank in Accounts.")}`;
  const used = n.coverage.filter((c) => c.included).length;
  const sources = n.coverage
    .map((c) => `<li class="fnm-row"><span class="fnm-txmain"><strong>${esc(c.name)}</strong><span class="jds-hint">${esc(c.included ? `As of ${c.asOf ? shortDayLabel(c.asOf) : "now"}` : `Not included · ${String(c.reason ?? "").replace(/_/g, " ")}`)}</span></span><span class="fnm-money">${c.balanceCents === null ? "" : formatCents(c.balanceCents, iso)}</span></li>`)
    .join("");
  const start = r.historyPage * PAGE;
  const rows = [...n.points].reverse().slice(start, start + PAGE)
    .map((p) => `<li class="fnm-row"><span>${esc(shortDayLabel(p.date))}</span><span class="fnm-money">${formatCents(p.totalCents, iso)}</span></li>`)
    .join("");
  const pager = `<div class="fnm-chips">${r.historyPage > 0 ? button("Newer balances", { act: "rpt-hist-newer" }) : ""}${start + PAGE < n.points.length ? button("Older balances", { act: "rpt-hist-older" }) : ""}</div>`;
  return `${sectionHead("Net worth")}<p class="fnm-money jds-display">${formatCents(n.headlineCents, iso)}</p><p class="jds-hint">As of ${esc(shortDayLabel(n.asOf))}</p>${trend(n.points, `Net worth over ${n.points.length} days`)}<p class="jds-hint">${used} of ${n.coverage.length} accounts included in this total.</p>${disclosure("sources", "Balance sources", r.open.sources, `<ul class="fnm-feed">${sources}</ul>`)}${disclosure("history", "Balance history", r.open.history, `<ul class="fnm-feed">${rows}</ul>${pager}`)}`;
}

function bars(title, caption, list, iso, nameOf, group, month, folded, open) {
  if (list.length === 0) return "";
  const top = Math.max(...list.map(([, v]) => v));
  const items = list
    .map(([k, v], i) => `<li class="fnm-report-bar-row${i >= 5 ? " fnm-report-bar-row--fold" : ""}"><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="rpt-detail" data-group="${group}" data-key="${esc(k)}" data-month="${month}">${esc(nameOf(k))}</button><span class="fnm-money">${formatCents(v, iso)}</span><svg class="fnm-report-bar" height="6" aria-hidden="true"><rect width="${Math.max(2, Math.round((v / top) * 100))}%" height="6" rx="3" fill="var(--accent-fg)"/></svg></li>`)
    .join("");
  const more = folded > 5 ? `<div class="fnm-report-more">${button(open ? "Show top 5" : `Show all ${folded}`, { act: "rpt-more", extra: ` data-id="${group}"` })}</div>` : "";
  return `${sectionHead(title, caption)}<ul class="fnm-report-bars${open ? " is-open" : ""}">${items}</ul>${more}`;
}

function cashFlow(months, iso, r) {
  const peak = Math.max(1, ...months.map((m) => Math.max(m.cashFlow.incomeCents, m.cashFlow.outflowCents)));
  const w = 600;
  const h = 140;
  const slot = w / months.length;
  const y = (v) => h - 8 - (v / peak) * (h - 24);
  const cols = months.map((m, i) => {
    const x = i * slot + slot * 0.15;
    const bw = slot * 0.3;
    const inc = y(m.cashFlow.incomeCents);
    const out = y(m.cashFlow.outflowCents);
    const dot = y(Math.max(0, m.cashFlow.netCents));
    return `<rect x="${x.toFixed(1)}" y="${inc.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - 8 - inc).toFixed(1)}" fill="var(--accent-fg)"/><rect x="${(x + bw + 2).toFixed(1)}" y="${out.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - 8 - out).toFixed(1)}" fill="var(--steel)"/><circle cx="${(x + bw).toFixed(1)}" cy="${dot.toFixed(1)}" r="3" fill="var(--text)"/>`;
  }).join("");
  const table = `<table class="fnm-table"><thead><tr><th>Month</th><th>Income</th><th>Outflow</th><th>Net</th></tr></thead><tbody>${months.map((m) => `<tr><td>${esc(monthLabel(m.month))}</td><td><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="rpt-detail" data-group="income" data-key="" data-month="${m.month}">${formatCents(m.cashFlow.incomeCents, iso)}</button></td><td><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-act="rpt-detail" data-group="outflow" data-key="" data-month="${m.month}">${formatCents(m.cashFlow.outflowCents, iso)}</button></td><td>${formatCents(m.cashFlow.netCents, iso)}</td></tr>`).join("")}</tbody></table>`;
  return `${sectionHead("Cash flow")}<svg class="fnm-report-trend" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Income and outflow by month">${cols}</svg><p class="jds-hint">The dot marks net cash flow, income minus outflow.</p><p class="jds-hint">${months.map((m) => shortMonthLabel(m.month)).join(" · ")}</p>${disclosure("monthly", "Monthly numbers", r.open.monthly, table)}`;
}

function detail(d, iso) {
  if (!d) return "";
  const body = d.error
    ? note("danger", "The transactions didn't load.")
    : !d.data
      ? loadingLine("Loading")
      : `<p class="fnm-money">Report amount ${formatCents(d.data.totalCents, iso)}</p><ul class="fnm-feed">${d.data.rows.map((t) => `<li class="fnm-row"><span class="fnm-txmain"><strong>${esc(t.name)}</strong><span class="jds-hint">${esc(`${shortDayLabel(t.date)} · ${t.accountName}${t.pending ? " · pending" : ""}`)}</span></span><span class="fnm-money">${formatCents(t.amountCents, iso)}</span></li>`).join("")}</ul><div class="fnm-chips">${d.offset > 0 ? button("Previous page", { act: "rpt-page-prev" }) : ""}${d.data.offset + d.data.rows.length < d.data.totalCount ? button("Next page", { act: "rpt-page-next" }) : ""}</div>`;
  return dialogHtml({ title: d.title, body, footer: `${button("Reload details", { act: "rpt-detail-reload", variant: "quiet" })}${button("Close", { act: "dialog-close" })}` });
}

export function reportsView(r) {
  const controls = `<div class="fnm-chips">${select("months", PERIODS.map((m) => [m, `Last ${m} months`]), r.months, "Report period")}${r.spend?.currencies?.length > 1 ? select("currency", [["", "Choose currency"], ...r.spend.currencies.map((c) => [c, c])], r.currency, "Choose currency") : ""}${button("Refresh", { act: "rpt-reload" })}</div>`;
  if (r.spendError && r.netError) return `${controls}${errorState("Spending didn't load.", button("Try again", { act: "rpt-reload" }))}`;
  if (!r.spend && !r.spendError) return `${controls}${loadingLine("Loading reports")}`;
  const s = r.spend;
  if (s && s.currencySelectionRequired) return `${controls}${emptyState("Choose a currency", "Your accounts use more than one currency.")}`;
  if (s && s.currencies.length === 0 && !r.net?.points?.length) {
    return `${controls}${emptyState("Nothing to report yet", "Add an account and Moss builds your reports.", button("Add an account", { act: "rpt-add-account", variant: "primary" }))}`;
  }
  const iso = s?.currency ?? r.currency ?? "USD";
  const months = s ? mergeSpending(s.window, s.own, s.shared) : [];
  const month = r.barMonth && s?.window.includes(r.barMonth) ? r.barMonth : defaultBarMonth(s?.window ?? []);
  const picked = months.find((m) => m.month === month);
  const cats = new Map((s?.categories ?? []).map((c) => [c.id, c.name]));
  const catName = (id) => cats.get(id) ?? id;
  const spending = r.spendError
    ? errorState("Spending didn't load.", button("Try again", { act: "rpt-reload" }))
    : !hasActivity(months)
      ? emptyState("No transactions yet", "Add or import transactions in Accounts.")
      : (() => {
          const monthSelect = select("barMonth", (s.window ?? []).map((m) => [m, monthLabel(m)]), month, "Month for spending");
          const c = ranked(picked?.byCategory ?? {});
          const p = ranked(picked?.byPayee ?? {}, 12);
          const body = c.length === 0 ? emptyState("No spending this month") : `${bars("Spending by category", "", c, iso, catName, "category", month, c.length, r.open.category)}${bars("Spending by payee", "Top 12 payees", p, iso, (k) => k, "payee", month, p.length, r.open.payee)}`;
          const shared = s.shared.length ? note("info", "Includes shared household accounts") : "";
          return `<div class="fnm-chips">${monthSelect}</div>${body}${shared}${cashFlow(months, iso, r)}`;
        })();
  return `${controls}${netWorth(r, iso)}${spending}${detail(r.detail, iso)}`;
}
